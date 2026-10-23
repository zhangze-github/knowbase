import fs from "node:fs";
import path from "node:path";
import {
  Config,
  Logger,
  writeDaemonState,
  readDaemonState,
  pidAlive,
  DaemonState,
} from "./config.js";
import * as git from "./git.js";
import { createDebouncer, startWatcher } from "./watcher.js";
import { syncAgentConfig } from "./agent-config.js";
import { syncSkills, summarizeByTool } from "./skills-sync.js";
import { isMirrorMode, setMirrorLock, discardLocalChanges } from "./mirror.js";

export interface SyncDeps {
  logger: Logger;
}

export interface SyncResult {
  /** 本轮从远端跟进了新内容（reset 到上游）。 */
  merged: boolean;
  /** 本轮被丢弃的本地改动（相对路径）。 */
  discardedFiles: string[];
  /**
   * 仓库不是飞书镜像（缺 .knowbase-mirror.json），本轮什么都没做。
   * 见 syncOnce 的说明：这种仓库**必须**原地不动。
   */
  notMirror: boolean;
  /** 网络/致命步骤出错时的说明；引擎本身不抛异常。 */
  error?: string;
}

const REMOTE = "origin";

function emptyResult(): SyncResult {
  return { merged: false, discardedFiles: [], notMirror: false };
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
 * 执行一次完整同步周期。永不抛异常：网络失败记录到 result.error，交由下一周期重试。
 *
 * **非镜像仓库一律原地不动**。1.0.0 废弃了经典模式（本地可写、双向同步），
 * 同步路径只剩单向下行，而下行的手段是 `git reset --hard`——把一个经典仓库
 * 按镜像处理，等于把成员尚未推送的本地内容全部抹掉。宁可什么都不做并每轮
 * 报一条明确的错，也不能让升级动作本身变成数据丢失事故。
 */
export function syncOnce(cfg: Config, deps: SyncDeps): SyncResult {
  if (!isMirrorMode(cfg.dir)) {
    const result = emptyResult();
    result.notMirror = true;
    result.error =
      "该仓库不是飞书镜像（缺 .knowbase-mirror.json），已跳过同步。" +
      "1.0.0 起只支持飞书镜像模式；经典双向同步仓库请留在 0.9.x，或改用 exporter 产出镜像仓库。";
    deps.logger.log(result.error);
    return result;
  }
  return mirrorSyncOnce(cfg, deps);
}

/**
 * 镜像模式的同步周期（spec §4.2/§4.3）：严格单向下行。
 * 永不 commit、永不 push；本地一切改动直接丢弃（§4.3，
 * 定稿决策：不留底，改动入口只有飞书）；远端永远是对的，本地历史被人
 * 手动动过就 reset --hard。与 syncOnce 同样 never throw。
 */
export function mirrorSyncOnce(cfg: Config, deps: SyncDeps): SyncResult {
  const { logger } = deps;
  const result = emptyResult();
  const dir = cfg.dir;

  try {
    clearStaleLock(dir, logger);

    // 稳态（无本地改动、无需 reset）零 chmod：chmod 会触发 fs.watch 事件，
    // watcher 防抖后又排一轮新周期，若每轮无条件解锁/上锁就会自触发成死循环
    // （周期坍缩为防抖窗口那么短，实测 macOS/Linux 均可复现）。因此只在
    // 确实要做写操作（丢弃改动 / reset）前才解锁，finally 的收尾上锁本身是
    // 幂等的——已经是 444 时不产生 chmod 调用、返回 0。
    if (git.hasChanges(dir)) {
      setMirrorLock(dir, false);
      const discard = discardLocalChanges(dir);
      if (discard.error) {
        // 与 fetch 失败同一模式：记录、留给下一周期重试，本轮不再继续。
        result.error = `丢弃本地改动失败：${discard.error}`;
        logger.log(result.error + "（下一周期重试）");
        return result;
      }
      if (discard.files.length > 0) {
        result.discardedFiles = discard.files;
        logger.log(
          `镜像目录被本地修改，已丢弃 ${discard.files.length} 个文件的改动：${discard.files.join(", ")}` +
            `（修改请走飞书文档，见各文件头部 feishu_url）`
        );
      }
    }

    const f = git.fetch(dir, REMOTE);
    if (!git.ok(f)) {
      result.error = `fetch 失败：${f.stderr.trim() || f.stdout.trim()}`;
      logger.log(result.error + "（下一周期重试）");
      return result;
    }

    const upstream = `${REMOTE}/${cfg.branch}`;
    if (
      git.upstreamExists(dir, upstream) &&
      (git.behindCount(dir, upstream) > 0 || git.aheadCount(dir, upstream) > 0)
    ) {
      // behind：正常跟进。ahead/分叉：有人绕过锁手动 commit 过——镜像仓库的
      // 本地历史没有保留价值，硬复位即「丢弃改动」在提交层面的同一原则。
      // 仅在真正需要 reset 时解锁（Windows 只读属性会阻止 reset --hard
      // 删除/覆盖文件）；已经解锁过（本轮丢弃过改动）时 setMirrorLock 幂等。
      setMirrorLock(dir, false);
      const r = git.resetHard(dir, upstream);
      if (git.ok(r)) {
        result.merged = true;
      } else {
        result.error = `reset 失败：${(r.stderr || r.stdout).trim()}`;
        logger.log(result.error + "（下一周期重试）");
      }
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    logger.log(`镜像同步周期异常：${result.error}`);
  } finally {
    // 无论成败都恢复上锁：解锁窗口越短，agent 撞进来的概率越低
    try {
      setMirrorLock(dir, true);
    } catch {
      // never throw
    }
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
 * 每个同步周期末刷新 agent 提示词中的知识库目录树快照。
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
    const changes = syncAgentConfig(cfg.dir, home, { onlyExisting: true, hermesHome: cfg.hermesHome });
    for (const c of changes) {
      if (c.action !== "skipped") continue;
      if (c.reason) {
        logger.log(`${c.name} 知识库上下文已跳过刷新：${c.reason}`);
        continue;
      }
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
        `agent 提示词目录树已刷新：${touched.map((c) => c.name).join(", ")}`
      );
    }
  } catch (e) {
    logger.log(
      `刷新 agent 提示词失败（已忽略）：${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * 每个同步周期末把知识库 skills/ 分发到所有生效目标（skillTargets）。
 *
 * 与 refreshAgentPrompts 一样：纯本地读 + 写本机 ~/.claude/、~/.codex/，不碰 git，
 * 因此不受 .knowbase-pause 影响；任何异常只记日志，不能影响 SyncResult /
 * DaemonState，也不能让守护进程退出。
 *
 * 与 refreshAgentPrompts 的**刻意不同**：这里没有 onlyExisting 语义。
 * 提示词区块在用户的个人文件里，删掉它是「别往我提示词里塞东西」最自然的
 * 表达，所以后台从不重建；而删掉某个目标里的 org-foo/ 会连标记一起
 * 删掉，「记住用户拒绝过这一个」需要引入新的持久化状态，而 opt-out 在配置层
 * 已经有了（--no-skills）。所以托管副本删掉后下个周期会被重新分发。
 * 这是单向下发 + 静默覆盖的直接推论，不是 bug，别顺手「修」掉。
 */
export function refreshOrgSkills(
  cfg: Config,
  logger: Logger,
  home?: string
): void {
  if (cfg.skills === false) return;
  try {
    const changes = syncSkills(cfg.dir, home, cfg.hermesHome);
    const done = changes.filter(
      (c) => c.action === "created" || c.action === "updated" || c.action === "removed"
    );
    if (done.length > 0) {
      logger.log(`团队 skills 已更新：${summarizeByTool(done, (c) => `${c.target}(${c.action})`)}`);
    }
    for (const c of changes) {
      if (c.action === "foreign" || c.action === "invalid" || c.action === "failed") {
        const where = c.tool ? `，${c.tool}` : "";
        logger.log(`团队 skill ${c.name} 未分发（${c.action}${where}）：${c.reason}`);
      }
    }
  } catch (e) {
    logger.log(
      `分发团队 skills 失败（已忽略）：${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * 守护进程主体：混合调度。
 * - 下行轮询：固定 interval fetch 远端改动（Git 无推送通知，轮询不可省），这是
 *   镜像跟进飞书内容的主路径。
 * - 文件监听 + 防抖：镜像目录是只读的，监听的意义不再是加速上行，而是本地一旦
 *   被改（绕过只读位、或某个工具写入）立刻触发一轮丢弃，把偏离窗口压到几秒。
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

  // syncOnce 是同步阻塞的，事件循环保证不会重入。
  // 不设「同步后屏蔽窗」：屏蔽会丢掉紧跟同步之后的用户编辑（只能干等下轮轮询）。
  // 同步自身写盘（merge 落盘/冲突副本）最多引发一次空跑同步——空跑无改动、
  // 只动 .git（已过滤），不会形成风暴，天然收敛。
  const runCycle = (): void => {
    try {
      const r = syncOnce(cfg, deps);
      state.lastCycleAt = new Date().toISOString();
      state.lastError = r.error;
      if (!r.error) {
        state.lastOkCycleAt = state.lastCycleAt;
        if (r.merged) state.lastSyncOkAt = state.lastCycleAt;
      }
      if (r.discardedFiles.length > 0) {
        state.lastDiscard = { at: state.lastCycleAt!, files: r.discardedFiles };
      }
      writeDaemonState(state);
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e);
      state.lastCycleAt = new Date().toISOString();
      writeDaemonState(state);
      logger.log(`守护循环异常（已捕获）：${state.lastError}`);
    }
    refreshAgentPrompts(cfg, logger);
    refreshOrgSkills(cfg, logger);
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
