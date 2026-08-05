import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 暂停标记文件名（product.md §2.5）。存在即跳过同步周期。 */
export const PAUSE_MARKER = ".knowbase-pause";

/** 默认同步间隔（秒）。 */
export const DEFAULT_INTERVAL = 60;

/** 默认分支。 */
export const DEFAULT_BRANCH = "main";

/** 默认知识库目录。 */
export function defaultDir(): string {
  return path.join(os.homedir(), "org-kb");
}

export interface Config {
  /** Git 远端地址。 */
  repoUrl: string;
  /** 本地知识库目录（绝对路径）。 */
  dir: string;
  /** 下行轮询间隔，单位秒（上行由文件监听+防抖触发）。 */
  interval: number;
  /** 同步分支。 */
  branch: string;
  /** 是否启用文件监听上行加速（默认 true；手动改配置可关）。 */
  watch?: boolean;
  /** 是否维护 AI agent 全局提示词托管区块（默认 true；init --no-agent-config 存 false）。 */
  agentConfig?: boolean;
  /** 是否把知识库 skills/ 分发到 ~/.claude/skills（默认 true；init --no-skills 存 false）。 */
  skills?: boolean;
}

/** 配置目录：$XDG_CONFIG_HOME/knowbase 或 ~/.config/knowbase 。 */
export function configDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== ""
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");
  return path.join(base, "knowbase");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function logPath(): string {
  return path.join(configDir(), "knowbase.log");
}

/**
 * launchd/systemd 重定向守护进程 stdout/stderr 的独立文件。
 * 不能与 logPath() 共用：Logger 用 rename 轮转，服务管理器持有的旧 fd
 * 会继续写入改名后的文件，崩溃堆栈这类关键输出会落错地方。
 */
export function daemonStdoutPath(): string {
  return path.join(configDir(), "daemon.stdout.log");
}

export function daemonStatePath(): string {
  return path.join(configDir(), "daemon.state.json");
}

/** push 熔断状态快照（写入 DaemonState 供 status 展示）。 */
export interface PushBlocked {
  /** 首次判定无权限的时刻（ISO）。 */
  since: string;
  /** 服务端给出的原因原文（单行）。 */
  reason: string;
  /** 下一次自动探测的时刻（ISO）。 */
  nextProbeAt: string;
}

/** 守护进程心跳状态：CLI 与守护进程之间无 IPC，靠这个文件传递健康度。 */
export interface DaemonState {
  pid: number;
  startedAt: string;
  /** 最近一次同步周期结束时间。 */
  lastCycleAt?: string;
  /** 最近一次「有效同步」（提交/合并/推送成功且无错误）时间。 */
  lastSyncOkAt?: string;
  /** 最近一次无异常周期（含「检查过且已一致」）时间——比 lastSyncOkAt 更能反映健康度。 */
  lastOkCycleAt?: string;
  /** 最近一次周期的错误说明（网络失败等）。 */
  lastError?: string;
  paused?: boolean;
  /** 无 push 权限而熔断时存在；恢复后清空。 */
  pushBlocked?: PushBlocked;
}

export function writeDaemonState(state: DaemonState): void {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(daemonStatePath(), JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // 状态写入失败不能拖垮守护进程
  }
}

export function readDaemonState(): DaemonState | null {
  try {
    return JSON.parse(fs.readFileSync(daemonStatePath(), "utf8")) as DaemonState;
  } catch {
    return null;
  }
}

export function clearDaemonState(): void {
  try {
    fs.rmSync(daemonStatePath(), { force: true });
  } catch {
    // ignore
  }
}

/** 进程是否存活（signal 0 探测）。 */
export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH: 不存在; EPERM: 存在但无权限（视为存活）
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 暂停标记文件的完整路径。 */
export function pauseMarkerPath(dir: string): string {
  return path.join(dir, PAUSE_MARKER);
}

export function isPaused(dir: string): boolean {
  return fs.existsSync(pauseMarkerPath(dir));
}

export function configExists(): boolean {
  return fs.existsSync(configPath());
}

export function loadConfig(): Config {
  const p = configPath();
  if (!fs.existsSync(p)) {
    throw new Error(`未找到配置文件 ${p}，请先运行 knowbase init <git-url>`);
  }
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as Partial<Config>;
  if (!parsed.repoUrl || !parsed.dir) {
    throw new Error(`配置文件 ${p} 不完整（缺少 repoUrl 或 dir）`);
  }
  return {
    repoUrl: parsed.repoUrl,
    dir: parsed.dir,
    interval: parsed.interval ?? DEFAULT_INTERVAL,
    branch: parsed.branch ?? DEFAULT_BRANCH,
    watch: parsed.watch !== false,
    agentConfig: parsed.agentConfig !== false,
    skills: parsed.skills !== false,
  };
}

export function saveConfig(cfg: Config): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/**
 * 主机名，清洗为仅含 [A-Za-z0-9._-]，用于提交信息与冲突副本文件名。
 */
export function safeHostname(): string {
  const h = os.hostname() || "unknown";
  const cleaned = h.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

/**
 * 生成紧凑时间戳 YYYYMMDDTHHmmss（本地时间），用于冲突副本命名。
 */
export function timestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const MAX_LOG_BYTES = 1024 * 1024; // 1MB 滚动

/**
 * 简单滚动日志：写入 knowbase.log；超过 1MB 时轮转为 knowbase.log.1。
 * 守护进程与前台命令共用。
 */
export class Logger {
  private file: string;

  constructor(file: string = logPath()) {
    this.file = file;
  }

  path(): string {
    return this.file;
  }

  private rotateIfNeeded(): void {
    try {
      const st = fs.statSync(this.file);
      if (st.size > MAX_LOG_BYTES) {
        fs.renameSync(this.file, this.file + ".1");
      }
    } catch {
      // 文件不存在，无需轮转
    }
  }

  log(message: string): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.rotateIfNeeded();
      const line = `${new Date().toISOString()} ${message}\n`;
      fs.appendFileSync(this.file, line, "utf8");
    } catch {
      // 日志失败绝不能拖垮守护进程
    }
  }

  /** 读取最近 n 行日志（供 status 展示）。 */
  tail(n: number): string[] {
    try {
      const content = fs.readFileSync(this.file, "utf8");
      const lines = content.split("\n").filter((l) => l.length > 0);
      return lines.slice(-n);
    } catch {
      return [];
    }
  }
}
