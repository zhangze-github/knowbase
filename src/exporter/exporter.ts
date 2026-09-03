import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Logger } from "../config.js";
import { addAll, commit, hasChanges, mv as gitMv, ok, push, pushFailureReason } from "../git.js";
import {
  newManifest,
  readExporterManifest,
  writeExporterManifest,
} from "./manifest.js";
import { planPaths, diffTree, type WikiNode, type PlannedNode } from "./tree-diff.js";
import { renderDocxToMarkdown } from "./docx-md.js";
import type { DocxBlock } from "./lark-client.js";

/** 集成测试注入 fake 的最小面（真实实现见 lark-client.ts 的 LarkClient）。 */
export interface LarkClientLike {
  listAllSpaceNodes(spaceId: string, root?: string): Promise<WikiNode[]>;
  listDocBlocks(documentId: string): Promise<DocxBlock[]>;
}

export interface ExporterConfig {
  repoDir: string;
  branch: string;
  spaceId: string;
  host: string;
  rootToken?: string;
  inboxUrl?: string;
  /** 全量对账间隔 ms，默认 24h（Task 7 增量对账触发全量兜底用；本任务恒为全量）。 */
  fullCheckMs?: number;
}

export interface ExportResult {
  exported: number;
  moved: number;
  removed: number;
  committed: boolean;
  pushed: boolean;
  error?: string;
}

/** 默认 24h（供 Task 7 消费；本任务不读取此值）。 */
export const DEFAULT_FULL_CHECK_MS = 24 * 60 * 60 * 1000;

/**
 * skills/ 防御（spec §8）：写盘/mv/删除的目标路径若落在 skills/ 目录内一律跳过。
 * 结构上 planPaths 的产物不会落在 skills/ 下（不共享同一个命名空间），
 * 这里是 toRemove 清理「旧状态」时的最后一道防线，防止误删被分发到成员侧的技能目录。
 */
function isProtectedPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/");
  return norm === "skills" || norm.startsWith("skills/");
}

/**
 * frontmatter 精确格式（用户核心验收项）：feishu_url/title/synced_at/managed_by 四行，
 * title 用 JSON.stringify 转义，末尾留一个空行与正文分隔。
 */
function buildFrontmatter(host: string, node: WikiNode, now: Date): string {
  return (
    `---\n` +
    `feishu_url: https://${host}/wiki/${node.node_token}\n` +
    `title: ${JSON.stringify(node.title)}\n` +
    `synced_at: ${now.toISOString()}\n` +
    `managed_by: knowbase-mirror\n` +
    `---\n\n`
  );
}

/**
 * 内容 hash：正文 + title，刻意不含 synced_at——否则每轮全量对账时 synced_at 必然
 * 不同，会把「内容其实没变」的节点也判成需要重写，全量对账永远无法收敛到心跳提交。
 */
function contentHash(body: string, title: string): string {
  return createHash("sha256").update(body + title).digest("hex");
}

/** 自底向上删空目录（toRemove 顺手清理），失败（非空/权限）忽略。 */
function rmEmptyDirsUpward(repoDir: string, startDir: string): void {
  let dir = startDir;
  const root = path.resolve(repoDir);
  while (path.resolve(dir) !== root && path.resolve(dir).startsWith(root)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break; // 非空或权限问题：忽略，停止向上清理
    }
    dir = path.dirname(dir);
  }
}

/** 渲染 toExport 单节点正文；docx 走真实转换，其余 obj_type 走占位。 */
async function renderBody(
  client: LarkClientLike,
  p: PlannedNode,
  planned: Map<string, PlannedNode>,
  host: string
): Promise<string> {
  const selfUrl = `https://${host}/wiki/${p.node.node_token}`;
  if (p.node.obj_type === "docx") {
    const blocks = await client.listDocBlocks(p.node.obj_token);
    return renderDocxToMarkdown(blocks, {
      selfUrl,
      selfPath: p.path,
      pathForToken: (t) => planned.get(t)?.path,
      urlForToken: (t) => {
        const target = planned.get(t);
        return target ? `https://${host}/wiki/${target.node.node_token}` : undefined;
      },
    });
  }
  return `> 此为飞书 ${p.node.obj_type}，请在飞书打开：[原文](${selfUrl})`;
}

/**
 * 导出编排（spec §3.3/§3.4/§3.6/§3.5/§8）：首轮全量——拉整棵树、diff、
 * 移动/导出/删除、更新 manifest、commit+push。任何异常都不向上抛，
 * 落到 result.error，交由上层守护循环下一周期重试。
 */
export async function runExportOnce(
  cfg: ExporterConfig,
  deps: { client: LarkClientLike; logger: Logger; now?: () => Date }
): Promise<ExportResult> {
  const now = deps.now ?? (() => new Date());
  const { client, logger } = deps;
  const result: ExportResult = {
    exported: 0,
    moved: 0,
    removed: 0,
    committed: false,
    pushed: false,
  };

  try {
    // 1. 读 manifest，首轮没有则新建
    const manifest = readExporterManifest(cfg.repoDir) ?? newManifest(cfg.spaceId, cfg.host, cfg.inboxUrl);

    // 2. 拉整棵树 → 规划路径 → 与旧状态 diff
    const nodes = await client.listAllSpaceNodes(cfg.spaceId, cfg.rootToken);
    const planned = planPaths(nodes, cfg.rootToken);
    const diff = diffTree(planned, manifest.nodes);

    // 3. toMove：git mv，失败降级 fs.renameSync，均失败则跳过（下轮按「未移动」重新计算 diff）
    for (const m of diff.toMove) {
      const token = m.to.node.node_token;
      if (isProtectedPath(m.from) || isProtectedPath(m.to.path)) {
        logger.log(`exporter: 跳过受保护路径 mv ${m.from} -> ${m.to.path}`);
        continue;
      }
      const fromAbs = path.join(cfg.repoDir, m.from);
      const toAbs = path.join(cfg.repoDir, m.to.path);
      try {
        fs.mkdirSync(path.dirname(toAbs), { recursive: true });
      } catch (e) {
        logger.log(`exporter: mkdir 失败，跳过移动 ${m.to.path}: ${String(e)}`);
        continue;
      }
      let moved = ok(gitMv(cfg.repoDir, m.from, m.to.path));
      if (!moved) {
        try {
          fs.renameSync(fromAbs, toAbs);
          moved = true;
        } catch (e) {
          logger.log(`exporter: 移动失败，跳过 ${m.from} -> ${m.to.path}: ${String(e)}`);
        }
      }
      if (moved) {
        if (manifest.nodes[token]) manifest.nodes[token].path = m.to.path;
        result.moved++;
      }
    }

    // 4. toExport：docx 渲染真实正文，其余占位；hash 相同跳过写盘但仍推进 manifest（幂等）
    let newCount = 0;
    let reexportCount = 0;
    for (const p of diff.toExport) {
      const token = p.node.node_token;
      if (isProtectedPath(p.path)) {
        logger.log(`exporter: 跳过受保护路径导出 ${p.path}`);
        continue;
      }

      let body: string;
      try {
        body = await renderBody(client, p, planned, cfg.host);
      } catch (e) {
        // 单篇失败（如 listDocBlocks 抛错）：记日志、跳过、不更新该节点 manifest（下轮重试），
        // 不置 result.error——这是「部分失败」而非「本轮致命错误」（spec §3.6）
        logger.log(`exporter: 导出节点失败，跳过 ${token} (${p.path}): ${String(e)}`);
        continue;
      }

      const hash = contentHash(body, p.node.title);
      const existing = manifest.nodes[token];
      const wasNew = !existing;
      if (!existing || existing.hash !== hash) {
        const abs = path.join(cfg.repoDir, p.path);
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, buildFrontmatter(cfg.host, p.node, now()) + body, "utf8");
        } catch (e) {
          logger.log(`exporter: 写盘失败，跳过 ${token} (${p.path}): ${String(e)}`);
          continue;
        }
      }
      manifest.nodes[token] = { path: p.path, obj_edit_time: p.node.obj_edit_time, hash };
      result.exported++;
      if (wasNew) newCount++;
      else reexportCount++;
    }

    // 5. toRemove：删文件 + 清 manifest 项，顺手清空目录
    for (const r of diff.toRemove) {
      if (isProtectedPath(r.path)) {
        logger.log(`exporter: 跳过受保护路径删除 ${r.path}`);
        continue;
      }
      const abs = path.join(cfg.repoDir, r.path);
      try {
        fs.rmSync(abs, { force: true });
      } catch (e) {
        logger.log(`exporter: 删除失败 ${r.path}: ${String(e)}`);
      }
      delete manifest.nodes[r.node_token];
      result.removed++;
      rmEmptyDirsUpward(cfg.repoDir, path.dirname(abs));
    }

    // 6. 推进 last_sync_at（成员侧 status 新鲜度依赖它持续推进，spec §3.4/§4.4）；
    //    本任务 runExportOnce 恒为全量对账，一并推进 last_full_check_at 供 Task 7 消费
    manifest.last_sync_at = now().toISOString();
    manifest.last_full_check_at = now().toISOString();
    writeExporterManifest(cfg.repoDir, manifest);

    // 7. git 发布
    if (hasChanges(cfg.repoDir)) {
      const addRes = addAll(cfg.repoDir);
      if (!ok(addRes)) {
        result.error = `git add 失败: ${addRes.stderr.trim() || addRes.stdout.trim()}`;
        logger.log(`exporter: ${result.error}`);
      } else {
        const contentChanged = newCount > 0 || reexportCount > 0 || result.removed > 0 || result.moved > 0;
        // 无内容变更（仅 last_sync_at 变化）时用心跳提交，避免看起来像空转，
        // 但仍然提交推送——成员侧新鲜度判定就靠这个持续推进（spec §3.4/§4.4，接受心跳提交）
        const message = contentChanged
          ? `mirror: +${newCount} ~${reexportCount} -${result.removed}`
          : `mirror: heartbeat`;
        const commitRes = commit(cfg.repoDir, message);
        if (!ok(commitRes)) {
          result.error = `git commit 失败: ${commitRes.stderr.trim() || commitRes.stdout.trim()}`;
          logger.log(`exporter: ${result.error}`);
        } else {
          result.committed = true;
          const pushRes = push(cfg.repoDir, "origin", cfg.branch);
          if (pushRes.ok) {
            result.pushed = true;
          } else {
            // push 失败（含并发竞争/权限问题）：记 result.error，下轮由上层守护循环重试
            result.error = `push 失败: ${pushFailureReason(pushRes.result)}`;
            logger.log(`exporter: ${result.error}`);
          }
        }
      }
    }
  } catch (e) {
    // 兜底：任何未预料的异常（listAllSpaceNodes 抛错、manifest 读写异常等）都不向上抛
    result.error = `导出失败: ${String(e)}`;
    logger.log(`exporter: ${result.error}`);
  }

  return result;
}
