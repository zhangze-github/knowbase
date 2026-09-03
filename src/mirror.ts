import fs from "node:fs";
import path from "node:path";
import * as git from "./git.js";
import { PAUSE_MARKER } from "./config.js";

/**
 * 飞书镜像模式（spec §4）：仓库根存在本清单文件即为镜像仓库。
 * 清单由 exporter 写入并随仓库分发，成员侧只读消费。
 */
export const MIRROR_MANIFEST = ".knowbase-mirror.json";

/** 成员侧消费的清单字段（spec §3.4/§5）；exporter 的其余字段原样保留不管。 */
export interface MirrorManifest {
  version: number;
  /** 最近一次 exporter 成功导出时刻（ISO8601）。 */
  last_sync_at?: string;
  /** 最近一次全量对账时刻（ISO8601）。 */
  last_full_check_at?: string;
  /** 「Agent 沉淀」目录的飞书 wiki URL，注入 agent 提示词（spec §5）。 */
  agent_inbox_url?: string;
}

export function mirrorManifestPath(dir: string): string {
  return path.join(dir, MIRROR_MANIFEST);
}

/**
 * 模式识别只看文件存在与否、刻意不解析内容：清单损坏时若退回经典模式，
 * daemon 会开始把成员的本地改动 commit/push 进镜像仓库——比「暂时读不到
 * 新鲜度」严重得多。损坏只影响 status 的新鲜度展示（spec §4.1）。
 */
export function isMirrorMode(dir: string): boolean {
  return fs.existsSync(mirrorManifestPath(dir));
}

export function readMirrorManifest(dir: string): MirrorManifest | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(mirrorManifestPath(dir), "utf8")
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as MirrorManifest;
  } catch {
    return null;
  }
}

/**
 * 上锁豁免（spec §4.3）：.git 与 node_modules 显然；skills/ 是 git 原生区
 * （spec §8），由 PR 维护、不来自飞书，不属于镜像内容。
 */
const LOCK_EXEMPT = new Set([".git", "skills", "node_modules"]);

function collectMd(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (LOCK_EXEMPT.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectMd(full, acc);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) acc.push(full);
  }
  return acc;
}

/**
 * 镜像内容只读锁（spec §4.3 硬防护）：agent 的 Edit/Write 当场报权限错误，
 * 失败即引导它回头读 frontmatter 走飞书通道。只锁 .md：其余文件（图片等
 * 附件）没有被 agent 顺手编辑的现实风险，锁面越小越不容易误伤。
 * Windows 上 chmod 映射为 read-only 属性，mode 回读不精确导致幂等判断失效、
 * 每轮全量 chmod——无害，接受。
 */
export function setMirrorLock(dir: string, locked: boolean): number {
  const mode = locked ? 0o444 : 0o644;
  let changed = 0;
  for (const f of collectMd(dir)) {
    try {
      if ((fs.statSync(f).mode & 0o777) === mode) continue;
      fs.chmodSync(f, mode);
      changed++;
    } catch {
      // 单个文件失败（并发删除等）不阻塞其余文件
    }
  }
  return changed;
}

/**
 * 丢弃镜像目录内的一切本地改动（spec §4.3 兜底）：镜像目录内不存在合法的
 * 本地修改，正确的修改入口只有飞书，因此直接丢弃、不留底；被丢弃的文件名
 * 由调用方记日志与 status 警告。-e 兜底 exporter 忘记把暂停标记种进
 * .gitignore 的情况——暂停标记是成员本机状态，误删等于静默取消用户的暂停。
 */
export function discardLocalChanges(dir: string): string[] {
  const files = git.changedFiles(dir);
  if (files.length === 0) return [];

  // git status 对完全未跟踪的目录，有时会显示目录名而不是文件名，需要展开
  const expandedFiles: string[] = [];
  for (const f of files) {
    if (f.endsWith("/")) {
      // 递归列出目录下所有文件
      const dirPath = path.join(dir, f);
      function listFiles(p: string, rel: string): void {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(p, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const fullPath = path.join(p, e.name);
          const relPath = path.join(rel, e.name);
          if (e.isDirectory()) {
            listFiles(fullPath, relPath);
          } else if (e.isFile()) {
            expandedFiles.push(relPath.replace(/\\/g, "/"));
          }
        }
      }
      listFiles(dirPath, f.slice(0, -1));
    } else {
      expandedFiles.push(f);
    }
  }

  git.checkoutAll(dir);
  git.cleanUntracked(dir, [PAUSE_MARKER]);
  return expandedFiles;
}
