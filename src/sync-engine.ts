import fs from "node:fs";
import path from "node:path";
import {
  Config,
  Logger,
  isPaused,
  safeHostname,
  timestamp,
  writeDaemonState,
  readDaemonState,
  pidAlive,
  DaemonState,
} from "./config.js";
import * as git from "./git.js";
import { createDebouncer, startWatcher } from "./watcher.js";
import { syncAgentConfig } from "./agent-config.js";
import { PushGate } from "./push-gate.js";

export interface SyncDeps {
  logger: Logger;
  /** 可注入的时间源，便于测试确定性生成冲突副本时间戳。 */
  now?: () => Date;
  /** 可注入主机名（默认取 safeHostname）。 */
  hostname?: string;
  /**
   * push 熔断器（守护进程长驻持有）。不传即不熔断——前台单次同步走这条路，
   * 用户主动跑 `knowbase sync` 就是想立刻知道现在通不通。
   */
  pushGate?: PushGate;
}

export interface SyncResult {
  paused: boolean;
  committed: boolean;
  merged: boolean;
  pushed: boolean;
  pushRejected: boolean;
  /** push 因权限/凭证被拒（重试无意义）。 */
  pushDenied: boolean;
  /** 因熔断跳过了本轮 push。 */
  pushSkipped: boolean;
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
    pushDenied: false,
    pushSkipped: false,
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

/** stale 判定阈值：正常 git 操作绝不会持锁这么久。 */
const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * 自愈：进程在 add/commit 中途被杀（关机、kill -9）会残留 .git/index.lock，
 * 之后每一轮 git 操作都失败且永不恢复。锁文件足够老时视为残留，直接清除。
 */
function clearStaleLock(dir: string, logger: Logger): void {
  const lock = path.join(dir, ".git", "index.lock");
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
      fs.rmSync(lock, { force: true });
      logger.log("检测到残留的 .git/index.lock（超过 10 分钟），已自动清除");
    }
  } catch {
    // 锁不存在（正常情况）
  }
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
    // 1.5 自愈残留锁
    clearStaleLock(dir, logger);

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
      const gate = deps.pushGate;
      const nowMs = (deps.now ? deps.now() : new Date()).getTime();
      if (gate && !gate.shouldAttempt(nowMs)) {
        // 熔断中且未到探测窗口：静默跳过。这里刻意不写日志——
        // 每周期一条错误日志本身就是本次要修的问题之一。
        result.pushSkipped = true;
      } else {
        const p = git.push(dir, REMOTE, cfg.branch);
        result.pushed = p.ok;
        result.pushRejected = p.rejected;
        result.pushDenied = p.denied;
        const reason = p.ok ? "" : git.pushFailureReason(p.result);
        const flip = gate?.record(p, reason, nowMs) ?? "unchanged";
        if (p.ok) {
          logger.log(flip === "recovered" ? "push 权限已恢复，继续推送" : "已推送到远端");
        } else if (p.denied) {
          result.error = `push 无权限：${reason}`;
          if (flip === "blocked") {
            logger.log(`push 无权限，已暂停推送（每 5 分钟自动重试一次）：${reason}`);
          } else if (!gate) {
            logger.log(`push 无权限：${reason}`);
          }
        } else if (p.rejected) {
          logger.log("push 被拒（并发竞争），下一周期先合并再推");
        } else {
          result.error = `push 失败：${(p.result.stderr || p.result.stdout).trim()}`;
          logger.log(result.error + "（下一周期重试）");
        }
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
/** 是否已有另一个守护进程实例在运行（单实例保护）。 */
export function anotherDaemonRunning(selfPid: number): boolean {
  const existing = readDaemonState();
  return !!existing && existing.pid !== selfPid && pidAlive(existing.pid);
}

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * 每个同步周期末刷新 agent 提示词中的知识库索引快照。
 *
 * 纯本地读 + 写提示词文件，不碰 git，因此不受 .knowbase-pause 影响。
 * 任何异常只记日志：不能影响 SyncResult / DaemonState，也不能让守护进程退出。
 *
 * onlyExisting：只刷新 init 建好的区块、从不创建。区块是用户个人提示词文件里的
 * 内容，删掉它就是「别再往我的提示词里塞东西」最自然的表达，后台不该写回去。
 */
export function refreshAgentPrompts(
  cfg: Config,
  logger: Logger,
  home?: string
): void {
  if (cfg.agentConfig === false) return;
  try {
    const changes = syncAgentConfig(cfg.dir, home, { onlyExisting: true });
    for (const c of changes) {
      if (c.action !== "skipped") continue;
      logger.log(
        `${c.name} 提示词 ${c.file} 中区块结束标记缺失，已跳过刷新` +
          `（强行写入会删掉标记之后的用户内容）；请手动检查该文件`
      );
    }
    const touched = changes.filter(
      (c) => c.action === "created" || c.action === "updated"
    );
    if (touched.length > 0) {
      logger.log(
        `agent 提示词索引已刷新：${touched.map((c) => c.name).join(", ")}`
      );
    }
  } catch (e) {
    logger.log(
      `刷新 agent 提示词失败（已忽略）：${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * 守护进程主体：混合调度。
 * - 上行加速：文件监听 + 防抖（静默 quietMs 触发，maxWaitMs 封顶防饿死），
 *   本地一有改动几秒内即推送，缩小多设备并发编辑的冲突窗口。
 * - 下行兜底：固定 interval 轮询 fetch 远端改动（Git 无推送通知，轮询不可省），
 *   同时兜住监听失效的情况——最坏退化为纯轮询，不会更糟。
 */
export async function runDaemon(cfg: Config, deps: SyncDeps): Promise<void> {
  const { logger } = deps;

  // 单实例保护：手动 `knowbase daemon` 与服务管理器拉起的实例并存时，
  // 双方会互踩状态文件、无谓竞争 git 锁。后来者直接退出。
  if (anotherDaemonRunning(process.pid)) {
    const msg = `已有守护进程在运行（pid ${readDaemonState()?.pid}），本实例退出`;
    logger.log(msg);
    console.error(msg);
    return;
  }

  const startedAt = new Date().toISOString();
  const state: DaemonState = { pid: process.pid, startedAt };
  writeDaemonState(state);

  // 熔断器长驻于守护进程内存：跨周期保持状态，随进程退出而清空。
  const gate = deps.pushGate ?? new PushGate();
  const cycleDeps: SyncDeps = { ...deps, pushGate: gate };

  // syncOnce 是同步阻塞的，事件循环保证不会重入。
  // 不设「同步后屏蔽窗」：屏蔽会丢掉紧跟同步之后的用户编辑（只能干等下轮轮询）。
  // 同步自身写盘（merge 落盘/冲突副本）最多引发一次空跑同步——空跑无改动、
  // 只动 .git（已过滤），不会形成风暴，天然收敛。
  const runCycle = (): void => {
    try {
      const r = syncOnce(cfg, cycleDeps);
      state.lastCycleAt = new Date().toISOString();
      state.paused = r.paused;
      state.lastError = r.error;
      if (!r.error && !r.paused) {
        state.lastOkCycleAt = state.lastCycleAt;
        if (r.committed || r.merged || r.pushed) {
          state.lastSyncOkAt = state.lastCycleAt;
        }
      }
      state.pushBlocked = gate.snapshot();
      writeDaemonState(state);
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e);
      state.lastCycleAt = new Date().toISOString();
      writeDaemonState(state);
      logger.log(`守护循环异常（已捕获）：${state.lastError}`);
    }
    refreshAgentPrompts(cfg, logger);
  };

  // 上行监听（可通过配置 watch:false 关闭；不支持递归监听的平台自动退化）
  let watching = false;
  if (cfg.watch !== false) {
    const quietMs = envInt("KNOWBASE_QUIET_MS", 3000);
    const maxWaitMs = envInt("KNOWBASE_MAXWAIT_MS", 30000);
    const debouncer = createDebouncer({
      quietMs,
      maxWaitMs,
      onFire: () => {
        debouncer.cancel();
        runCycle();
      },
    });
    const watcher = startWatcher(
      cfg.dir,
      () => debouncer.touch(),
      (e) => {
        logger.log(`文件监听中断（${e.message}），退化为纯轮询`);
      }
    );
    watching = watcher !== null;
    if (!watching) {
      logger.log("当前平台不支持递归文件监听，使用纯轮询");
    }
  }

  logger.log(
    `daemon 启动（pid ${process.pid}）：dir=${cfg.dir} branch=${cfg.branch} ` +
      `interval=${cfg.interval}s watch=${watching ? "on" : "off"}`
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    runCycle();
    await sleep(Math.max(1, cfg.interval) * 1000);
  }
}
