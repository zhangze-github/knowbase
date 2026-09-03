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
  /** 全量对账间隔 ms，默认 24h：manifest.last_full_check_at 缺失或早于 now-fullCheckMs 时，本轮忽略 obj_edit_time、对所有已知节点重渲染比 hash 兜底漏检（spec §3.4）。 */
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

/** 默认 24h 全量对账间隔。 */
export const DEFAULT_FULL_CHECK_MS = 24 * 60 * 60 * 1000;

/**
 * skills/ 防御（spec §8）：写盘/mv/删除的目标路径若落在 skills/ 目录内一律跳过。
 * 标题字面就是 "skills" 的 wiki 节点在 planPaths 的产物里是真实可达的路径
 * （用户完全可能建一个叫 skills 的页面/目录），这里是最后一道防线，防止写穿/
 * 误删到分发给成员侧的技能目录。
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

/**
 * 尝试把单个节点从旧路径移到新路径：先 git mv，失败降级 fs.rename，两者都失败返回
 * false。抽成独立函数是为了让「移动失败」的收尾逻辑（Important#2：跳过本轮导出，
 * 留给下轮和移动一起重试）能被纯逻辑单测覆盖，不必在集成测试里费力构造真实的
 * git mv 失败场景。
 */
export function tryMoveNode(
  from: string,
  to: string,
  logger: Logger,
  ops: {
    gitMv: (from: string, to: string) => boolean;
    rename: (from: string, to: string) => void;
  }
): boolean {
  if (ops.gitMv(from, to)) return true;
  try {
    ops.rename(from, to);
    return true;
  } catch (e) {
    logger.log(`exporter: 移动失败，跳过 ${from} -> ${to}: ${String(e)}`);
    return false;
  }
}

/** 渲染 toExport 单节点正文；docx 走真实转换，其余 obj_type 走占位。 */
async function renderBody(
  client: LarkClientLike,
  p: PlannedNode,
  planned: Map<string, PlannedNode>,
  byObjToken: Map<string, PlannedNode>,
  host: string
): Promise<string> {
  const selfUrl = `https://${host}/wiki/${p.node.node_token}`;
  if (p.node.obj_type === "docx") {
    const blocks = await client.listDocBlocks(p.node.obj_token);
    return renderDocxToMarkdown(blocks, {
      selfUrl,
      selfPath: p.path,
      // 先按 node_token 查，未命中再退化按 obj_token 查（见 runExportOnce 里 byObjToken
      // 的注释：mention_doc.token 对 wiki 文档可能落在 obj_token 命名空间）。
      pathForToken: (t) => planned.get(t)?.path ?? byObjToken.get(t)?.path,
      urlForToken: (t) => {
        const target = planned.get(t) ?? byObjToken.get(t);
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
    // 已有 manifest 时 newManifest 不会被调用，--inbox-url 就吃不到——运营者后补/更换
    // 收件箱链接必须能生效（spec §5），这里补上「已有 manifest」路径的更新。
    if (cfg.inboxUrl && manifest.agent_inbox_url !== cfg.inboxUrl) {
      manifest.agent_inbox_url = cfg.inboxUrl;
    }

    // 2. 拉整棵树 → 规划路径 → 与旧状态 diff
    const nodes = await client.listAllSpaceNodes(cfg.spaceId, cfg.rootToken);
    if (nodes.length === 0) {
      // 真实踩坑：bot 未加入知识空间时，列 space 顶层报 131006，但按 parent_node_token
      // 列子节点飞书**不报错、返回空列表**——exporter 会静默导出 0 个，极难定位。
      // 明确警告而不视为错误：空知识库/空子树也是合法状态，下轮照常重试。
      logger.log(
        "⚠ 知识库列不到任何节点：若知识库非空，请确认应用机器人已被加为该知识空间成员" +
          "（知识库设置 → 成员 → 添加成员里搜索应用名）；bot 无权限时子树列举表现为空列表而非报错"
      );
    }
    const planned = planPaths(nodes, cfg.rootToken);
    // mention_doc.token 的命名空间不总是 node_token：飞书历史上对 wiki 文档的 mention
    // 引用有时给的是 obj_token（fixture 形状踩过坑，真实运行需验收）。额外建一张按
    // obj_token 查的索引，pathForToken/urlForToken 命中失败时兜底查一次。
    const byObjToken = new Map<string, PlannedNode>();
    for (const p of planned.values()) byObjToken.set(p.node.obj_token, p);
    const diff = diffTree(planned, manifest.nodes);

    // 3. toMove：git mv，失败降级 fs.renameSync，均失败则记入 moveSkip（Important#2：
    //    该节点本轮不再导出——否则 toExport 会在新路径写出内容，旧文件因为 node_token
    //    仍「在树上」永远等不到 toRemove 清理，变成永久孤儿。留给下轮把移动和导出一起重试。
    const moveSkip = new Set<string>();
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
        moveSkip.add(token);
        continue;
      }
      const moved = tryMoveNode(m.from, m.to.path, logger, {
        gitMv: (f, t) => ok(gitMv(cfg.repoDir, f, t)),
        rename: (f, t) => fs.renameSync(path.join(cfg.repoDir, f), path.join(cfg.repoDir, t)),
      });
      if (moved) {
        if (manifest.nodes[token]) manifest.nodes[token].path = m.to.path;
        result.moved++;
      } else {
        moveSkip.add(token);
      }
    }

    // 4. toExport：diffTree 命中的（新增/edit_time 变化）之外，若本轮触达全量对账窗口，
    //    再把「已存在且 edit_time 未变」的节点也纳入重渲染比 hash（spec §3.4 兜底漏检：
    //    比如 API 偶发漏报 edit_time 变化）。reconcileOnly 的节点 hash 相同则完全跳过——
    //    不写盘、不计数、不动 manifest，否则连续两轮全量对账永远无法收敛到心跳提交。
    const fullCheckMs = cfg.fullCheckMs ?? DEFAULT_FULL_CHECK_MS;
    const dueFull =
      !manifest.last_full_check_at ||
      now().getTime() - new Date(manifest.last_full_check_at).getTime() >= fullCheckMs;

    const exportTokens = new Set(diff.toExport.map((p) => p.node.node_token));
    const exportItems: { p: PlannedNode; reconcileOnly: boolean }[] = diff.toExport.map((p) => ({
      p,
      reconcileOnly: false,
    }));
    if (dueFull) {
      for (const [token, p] of planned) {
        if (exportTokens.has(token)) continue; // 已经在正常 diff 里，不重复处理
        if (!manifest.nodes[token]) continue; // 新节点已由 diff.toExport 覆盖
        exportItems.push({ p, reconcileOnly: true });
      }
    }

    let newCount = 0;
    let reexportCount = 0;
    for (const { p, reconcileOnly } of exportItems) {
      const token = p.node.node_token;
      if (moveSkip.has(token)) {
        logger.log(`exporter: 移动未完成，本轮跳过导出 ${token} (${p.path})，留待下轮重试`);
        continue;
      }
      if (isProtectedPath(p.path)) {
        logger.log(`exporter: 跳过受保护路径导出 ${p.path}`);
        continue;
      }

      let body: string;
      try {
        body = await renderBody(client, p, planned, byObjToken, cfg.host);
      } catch (e) {
        // 单篇失败（如 listDocBlocks 抛错）：记日志、跳过、不更新该节点 manifest（下轮重试），
        // 不置 result.error——这是「部分失败」而非「本轮致命错误」（spec §3.6）
        logger.log(`exporter: 导出节点失败，跳过 ${token} (${p.path}): ${String(e)}`);
        continue;
      }

      const hash = contentHash(body, p.node.title);
      const existing = manifest.nodes[token];
      const wasNew = !existing;
      const changed = !existing || existing.hash !== hash;

      if (reconcileOnly && !changed) continue; // 全量对账兜底项：内容真的没变，不留任何痕迹

      if (changed) {
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
    //    last_full_check_at 只在本轮真的做了全量对账时才推进——否则从未触达
    //    fullCheckMs 窗口就被提前刷新，全量兜底永远不会被真正触发。
    manifest.last_sync_at = now().toISOString();
    if (dueFull) manifest.last_full_check_at = now().toISOString();
    writeExporterManifest(cfg.repoDir, manifest);

    // 7. git 发布
    if (hasChanges(cfg.repoDir)) {
      const addRes = addAll(cfg.repoDir);
      if (!ok(addRes)) {
        result.error = `git add 失败: ${addRes.stderr.trim() || addRes.stdout.trim()}`;
        logger.log(`exporter: ${result.error}`);
      } else {
        // 提交消息按「+新增 ~重导 -删除 →移动」拼段，计数为 0 的段省略；
        // 全为 0（含移动）才是心跳提交（Important#1：仅移动的一轮此前会被误判为心跳）。
        const segments: string[] = [];
        if (newCount > 0) segments.push(`+${newCount}`);
        if (reexportCount > 0) segments.push(`~${reexportCount}`);
        if (result.removed > 0) segments.push(`-${result.removed}`);
        if (result.moved > 0) segments.push(`→${result.moved}`);
        const message = segments.length > 0 ? `mirror: ${segments.join(" ")}` : `mirror: heartbeat`;
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

export interface DaemonOpts {
  /** 轮询间隔，单位秒。 */
  intervalSec: number;
  /** 测试注入：默认真实 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  /** 测试用：跑满这么多轮后 return（生产不传，无限循环）。 */
  maxCycles?: number;
}

// SIGTERM/SIGINT 优雅退出的 handler 只注册一次：runExporterDaemon 在长跑进程里只会被
// 调用一次，但测试里会反复调用（每次 maxCycles 跑完就 return），若不去重每次都会
// 新增一个 process 级 listener，多轮测试后触发 Node 的 MaxListenersExceededWarning。
let signalHandlersRegistered = false;

/**
 * 守护循环（spec：命令形态 + Task 8 brief）：`runExportOnce` → 记一行摘要日志 →
 * sleep(intervalSec*1000) → 重复。runExportOnce 本身 never throw（见上方实现的兜底
 * try/catch），这里再兜一层纯属防御性——防止未来改动不小心让它开始抛错时打断循环、
 * 让整个 exporter 进程意外退出。
 */
export async function runExporterDaemon(
  cfg: ExporterConfig,
  deps: { client: LarkClientLike; logger: Logger; now?: () => Date },
  opts: DaemonOpts
): Promise<void> {
  const { logger } = deps;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (!signalHandlersRegistered) {
    signalHandlersRegistered = true;
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.on(sig, () => {
        logger.log(`exporter: 收到 ${sig}，优雅退出`);
        process.exit(0);
      });
    }
  }

  let cycle = 0;
  for (;;) {
    let result: ExportResult;
    try {
      result = await runExportOnce(cfg, deps);
    } catch (e) {
      result = { exported: 0, moved: 0, removed: 0, committed: false, pushed: false, error: String(e) };
      logger.log(`exporter: 守护循环捕获未预期异常（不应发生，runExportOnce 应已兜底）: ${String(e)}`);
    }
    logger.log(
      `exporter: 周期完成 exported=${result.exported} moved=${result.moved} removed=${result.removed} ` +
        `pushed=${result.pushed}${result.error ? ` error=${result.error}` : ""}`
    );

    cycle++;
    if (opts.maxCycles !== undefined && cycle >= opts.maxCycles) return;
    await sleep(opts.intervalSec * 1000);
  }
}
