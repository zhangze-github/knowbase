import fs from "node:fs";
import path from "node:path";
import {
  Config,
  Logger,
  isPaused,
  safeHostname,
  timestamp,
  writeDaemonState,
  DaemonState,
} from "./config.js";
import * as git from "./git.js";

export interface SyncDeps {
  logger: Logger;
  /** 可注入的时间源，便于测试确定性生成冲突副本时间戳。 */
  now?: () => Date;
  /** 可注入主机名（默认取 safeHostname）。 */
  hostname?: string;
}

export interface SyncResult {
  paused: boolean;
  committed: boolean;
  merged: boolean;
  pushed: boolean;
  pushRejected: boolean;
  /** 本轮生成的冲突副本文件（相对路径）。 */
  conflictCopies: string[];
  /** 网络/致命步骤出错时的说明；引擎本身不抛异常。 */
  error?: string;
}

const REMOTE = "origin";

function emptyResult(): SyncResult {
  return {
    paused: false,
    committed: false,
    merged: false,
    pushed: false,
    pushRejected: false,
    conflictCopies: [],
  };
}

/** 生成自动提交信息：auto[host]: 文件列表（超过 3 个则计数）。 */
export function commitMessage(host: string, files: string[]): string {
  if (files.length === 0) return `auto[${host}]: 同步`;
  if (files.length <= 3) {
    return `auto[${host}]: ${files.join(", ")}`;
  }
  return `auto[${host}]: ${files.length} 个文件变更`;
}

/** 为冲突文件构造副本路径：原名.conflict-host-ts.ext（避免与已存在副本冲突）。 */
function conflictCopyPath(
  dir: string,
  file: string,
  host: string,
  ts: string
): string {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  let candidate = `${base}.conflict-${host}-${ts}${ext}`;
  let n = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}.conflict-${host}-${ts}-${n}${ext}`;
    n++;
  }
  return candidate;
}

/**
 * 处理 merge 后的非 md 冲突（union 覆盖不到的情况）——冲突副本兜底：
 * 本地版本另存副本，原文件采用远端版本，全部 add。返回副本相对路径列表。
 */
function handleConflicts(dir: string, deps: SyncDeps): string[] {
  const host = deps.hostname ?? safeHostname();
  const ts = timestamp(deps.now ? deps.now() : new Date());
  const copies: string[] = [];

  for (const file of git.unmergedFiles(dir)) {
    // 1. 保存本地版本（stage 2）为冲突副本；删改冲突时可能不存在，容错跳过
    const local = git.showStage2(dir, file);
    if (local != null) {
      const copyRel = conflictCopyPath(dir, file, host, ts);
      const full = path.join(dir, copyRel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, local);
      git.addPath(dir, copyRel);
      copies.push(copyRel);
    }
    // 2. 原文件采用远端版本；远端已删除则移除
    const theirs = git.checkoutTheirs(dir, file);
    if (git.ok(theirs)) {
      git.addPath(dir, file);
    } else {
      const rmRes = git.rm(dir, file);
      if (!git.ok(rmRes)) {
        // 兜底：无论如何把该路径的冲突状态清掉，避免阻塞
        git.addPath(dir, file);
      }
    }
  }
  return copies;
}

/**
 * 执行一次完整同步周期（product.md §2.2）。永不抛异常：
 * 网络失败记录到 result.error，交由下一周期重试。
 */
export function syncOnce(cfg: Config, deps: SyncDeps): SyncResult {
  const { logger } = deps;
  const result = emptyResult();
  const dir = cfg.dir;
  const host = deps.hostname ?? safeHostname();

  // 1. 暂停检查
  if (isPaused(dir)) {
    result.paused = true;
    logger.log("已暂停（存在 .knowbase-pause），跳过本轮");
    return result;
  }

  try {
    // 2. 本地有改动 → add -A → commit（先提交，保证 merge 面对干净工作区）
    if (git.hasChanges(dir)) {
      const files = git.changedFiles(dir);
      git.addAll(dir);
      const c = git.commit(dir, commitMessage(host, files));
      if (git.ok(c)) {
        result.committed = true;
        logger.log(`已提交本地改动：${files.join(", ")}`);
      } else if (!/nothing to commit/i.test(c.stdout + c.stderr)) {
        logger.log(`commit 异常：${(c.stderr || c.stdout).trim()}`);
      }
    }

    // 3. fetch
    const f = git.fetch(dir, REMOTE);
    if (!git.ok(f)) {
      result.error = `fetch 失败：${f.stderr.trim() || f.stdout.trim()}`;
      logger.log(result.error + "（下一周期重试）");
      return result;
    }

    const upstream = `${REMOTE}/${cfg.branch}`;

    // 4. 本地落后 → merge
    if (git.upstreamExists(dir, upstream) && git.behindCount(dir, upstream) > 0) {
      const m = git.merge(dir, upstream);
      if (git.ok(m)) {
        result.merged = true;
      } else {
        // union 已自动合并 md；到这里的都是非 md 冲突 → 冲突副本兜底
        const copies = handleConflicts(dir, deps);
        result.conflictCopies = copies;
        const done = git.commitNoEdit(dir);
        if (!git.ok(done)) {
          // 极端情况下仍有残留，记录但不阻塞
          logger.log(`合并提交异常：${(done.stderr || done.stdout).trim()}`);
        }
        result.merged = true;
        if (copies.length > 0) {
          logger.log(`生成冲突副本 ${copies.length} 个：${copies.join(", ")}`);
        }
      }
    }

    // 5. 本地领先 → push（被拒静默留待下轮）
    // upstream 不存在（远端尚无该分支）时，只要本轮有提交就尝试建立分支。
    const shouldPush = git.upstreamExists(dir, upstream)
      ? git.aheadCount(dir, upstream) > 0
      : result.committed || result.merged;
    if (shouldPush) {
      const p = git.push(dir, REMOTE, cfg.branch);
      result.pushed = p.ok;
      result.pushRejected = p.rejected;
      if (p.ok) {
        logger.log("已推送到远端");
      } else if (p.rejected) {
        logger.log("push 被拒（并发竞争），下一周期先合并再推");
      } else {
        result.error = `push 失败：${(p.result.stderr || p.result.stdout).trim()}`;
        logger.log(result.error + "（下一周期重试）");
      }
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    logger.log(`同步周期异常：${result.error}`);
  }

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 守护进程主体：固定周期跑同步循环，任何异常都不退出。
 * 由服务管理器拉起（launchd/systemd/schtasks）。
 */
export async function runDaemon(cfg: Config, deps: SyncDeps): Promise<void> {
  const { logger } = deps;
  const startedAt = new Date().toISOString();
  const state: DaemonState = { pid: process.pid, startedAt };
  writeDaemonState(state);
  logger.log(
    `daemon 启动（pid ${process.pid}）：dir=${cfg.dir} branch=${cfg.branch} interval=${cfg.interval}s`
  );
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = syncOnce(cfg, deps);
      state.lastCycleAt = new Date().toISOString();
      state.paused = r.paused;
      state.lastError = r.error;
      if (!r.error && !r.paused && (r.committed || r.merged || r.pushed)) {
        state.lastSyncOkAt = state.lastCycleAt;
      }
      writeDaemonState(state);
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e);
      state.lastCycleAt = new Date().toISOString();
      writeDaemonState(state);
      logger.log(`守护循环异常（已捕获）：${state.lastError}`);
    }
    await sleep(Math.max(1, cfg.interval) * 1000);
  }
}
