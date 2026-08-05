import { spawnSync, SpawnSyncOptions } from "node:child_process";
import { safeHostname } from "./config.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 让 git 全程非交互：凭证缺失时立刻失败，而不是挂起等待输入。 */
function nonInteractiveEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND:
      process.env.GIT_SSH_COMMAND ??
      "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    // 避免受用户全局 hooks / pager 干扰
    GIT_PAGER: "cat",
    // 固定 locale：git 自身的错误文案在中文环境下会被本地化，
    // 会让 classifyPushFailure 的英文关键词全部失配。
    LC_ALL: "C",
  };
}

/** 执行一次 git，返回结构化结果（不抛异常）。 */
export function git(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): GitResult {
  const spawnOpts: SpawnSyncOptions = {
    cwd: opts.cwd,
    env: nonInteractiveEnv(),
    encoding: "buffer",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  };
  const res = spawnSync("git", args, spawnOpts);
  const stdout = res.stdout ? res.stdout.toString("utf8") : "";
  const stderr = res.stderr ? res.stderr.toString("utf8") : "";
  // timeout / spawn 失败时 res.status 为 null
  const code = res.status == null ? 1 : res.status;
  return { code, stdout, stderr };
}

/** git 返回原始 buffer（用于二进制安全地取冲突文件内容）。 */
export function gitBuffer(
  args: string[],
  opts: { cwd?: string } = {}
): { code: number; stdout: Buffer } {
  const res = spawnSync("git", args, {
    cwd: opts.cwd,
    env: nonInteractiveEnv(),
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    code: res.status == null ? 1 : res.status,
    stdout: res.stdout ?? Buffer.alloc(0),
  };
}

export function ok(r: GitResult): boolean {
  return r.code === 0;
}

/** 取 stdout（去除首尾空白）；失败则抛异常。 */
export function out(args: string[], opts: { cwd?: string } = {}): string {
  const r = git(args, opts);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout.trim();
}

export function gitVersion(): string | null {
  const r = git(["--version"]);
  if (r.code !== 0) return null;
  const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : r.stdout.trim();
}

/** 验证远端可免交互访问（product.md §2.1 环境检查）。 */
export function lsRemote(url: string, timeoutMs = 20000): GitResult {
  return git(["ls-remote", url], { timeoutMs });
}

export function isRepo(dir: string): boolean {
  return ok(git(["rev-parse", "--is-inside-work-tree"], { cwd: dir }));
}

export function clone(url: string, dir: string, timeoutMs = 120000): GitResult {
  return git(["clone", url, dir], { timeoutMs });
}

/** 工作区是否有改动（含未跟踪文件）。 */
export function hasChanges(dir: string): boolean {
  const r = git(["status", "--porcelain"], { cwd: dir });
  return r.code === 0 && r.stdout.trim().length > 0;
}

/**
 * 解析 status --porcelain 的改动文件名（去重、去引号），用于生成提交信息。
 */
export function changedFiles(dir: string): string[] {
  const r = git(["status", "--porcelain"], { cwd: dir });
  if (r.code !== 0) return [];
  const files: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.trim() === "") continue;
    // 格式: XY <path> 或 XY <old> -> <new>
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    p = p.trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (p) files.push(p);
  }
  return files;
}

export function addAll(dir: string): GitResult {
  return git(["add", "-A"], { cwd: dir });
}

/** 该仓库视角下 git 身份（user.name + user.email）是否已配置。 */
export function hasIdentity(dir: string): boolean {
  const name = git(["config", "user.name"], { cwd: dir });
  const email = git(["config", "user.email"], { cwd: dir });
  return (
    name.code === 0 &&
    name.stdout.trim() !== "" &&
    email.code === 0 &&
    email.stdout.trim() !== ""
  );
}

/**
 * 身份兜底：目标用户可能从未配置过 git user.name/email，此时 commit/merge
 * 会永久失败（产品要求「安装即忘」）。仅在身份缺失时注入 -c 临时身份，
 * 已配置的机器不受影响。
 */
function identityArgs(dir: string): string[] {
  if (hasIdentity(dir)) return [];
  const host = safeHostname();
  return ["-c", `user.name=knowbase[${host}]`, "-c", `user.email=knowbase@${host}`];
}

export function commit(dir: string, message: string): GitResult {
  return git([...identityArgs(dir), "commit", "-m", message], { cwd: dir });
}

/** 完成一次 merge 提交（沿用 git 准备好的 MERGE_MSG）。 */
export function commitNoEdit(dir: string): GitResult {
  return git([...identityArgs(dir), "commit", "--no-edit"], { cwd: dir });
}

export function fetch(dir: string, remote: string, timeoutMs = 60000): GitResult {
  return git(["fetch", remote], { cwd: dir, timeoutMs });
}

export function currentBranch(dir: string): string {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
  return r.code === 0 ? r.stdout.trim() : "HEAD";
}

/** 本地相对 upstream 落后的提交数。 */
export function behindCount(dir: string, upstream: string): number {
  const r = git(["rev-list", "--count", `HEAD..${upstream}`], { cwd: dir });
  if (r.code !== 0) return 0;
  return parseInt(r.stdout.trim() || "0", 10);
}

/** 本地相对 upstream 领先的提交数。 */
export function aheadCount(dir: string, upstream: string): number {
  const r = git(["rev-list", "--count", `${upstream}..HEAD`], { cwd: dir });
  if (r.code !== 0) return 0;
  return parseInt(r.stdout.trim() || "0", 10);
}

/** upstream 引用是否存在（首次 clone 后一定存在；防御性检查）。 */
export function upstreamExists(dir: string, upstream: string): boolean {
  return ok(git(["rev-parse", "--verify", "--quiet", upstream], { cwd: dir }));
}

/** merge 指定 ref；返回结果（冲突时 code!=0，由调用方处理冲突副本）。 */
export function merge(dir: string, ref: string): GitResult {
  // merge 也会产生提交，同样需要身份兜底
  return git([...identityArgs(dir), "merge", "--no-edit", ref], { cwd: dir });
}

/** 处于冲突（未合并）状态的文件列表。 */
export function unmergedFiles(dir: string): string[] {
  const r = git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir });
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 取冲突文件的「本地版本」(stage 2) 内容；不存在（删改冲突）返回 null。 */
export function showStage2(dir: string, file: string): Buffer | null {
  const r = gitBuffer(["show", `:2:${file}`], { cwd: dir });
  if (r.code !== 0) return null;
  return r.stdout;
}

/** 冲突文件采用远端版本。 */
export function checkoutTheirs(dir: string, file: string): GitResult {
  return git(["checkout", "--theirs", "--", file], { cwd: dir });
}

export function rm(dir: string, file: string): GitResult {
  return git(["rm", "-f", "--", file], { cwd: dir });
}

export function addPath(dir: string, file: string): GitResult {
  return git(["add", "--", file], { cwd: dir });
}

/** push 失败的语义分类。 */
export type PushFailure = "denied" | "rejected" | "transient";

/**
 * 「重试必然同样失败」的关键词：凭证、权限、服务端策略。
 * 刻意不用裸 "403" / "401"——push 输出里的 delta 计数可能恰好是这些数字。
 */
const DENIED_PATTERNS = [
  "permission denied",
  "denied to",
  "access denied",
  "authentication failed",
  "could not read username",
  "could not read password",
  "terminal prompts disabled",
  "returned error: 403",
  "returned error: 401",
  "forbidden",
  "unauthorized",
  "you are not allowed to push",
  "pre-receive hook declined",
  "protected branch",
  "repository not found",
];

/** 并发竞争导致的 non-fast-forward：下一周期先合并再推即可。 */
const REJECTED_PATTERNS = [
  "rejected",
  "non-fast-forward",
  "fetch first",
  "failed to push some refs",
];

/**
 * 对 push 的失败输出分类。
 *
 * denied 必须先于 rejected 判定：GitLab 拒保护分支时输出同时含
 * "not allowed to push"（永久失败）与 "[remote rejected]"（看起来像并发竞争），
 * 顺序反了会把永久失败误当成竞争，退回每周期无限重试。
 */
export function classifyPushFailure(output: string): PushFailure {
  const text = output.toLowerCase();
  if (DENIED_PATTERNS.some((p) => text.includes(p))) return "denied";
  if (REJECTED_PATTERNS.some((p) => text.includes(p))) return "rejected";
  return "transient";
}

/** 从 git 输出里挑一行最能说明问题的作为原因，优先服务端 remote: 原文。 */
export function pushFailureReason(r: GitResult): string {
  const lines = (r.stderr + "\n" + r.stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const remote = lines.find((l) => l.toLowerCase().startsWith("remote:"));
  if (remote) return remote.replace(/^remote:\s*/i, "");
  const fatal = lines.find((l) => /^(fatal|error):/i.test(l));
  return fatal ?? lines[0] ?? "未知原因";
}

export interface PushOutcome {
  ok: boolean;
  /** 被拒（并发竞争 / non-fast-forward），下一周期先合并再推。 */
  rejected: boolean;
  /** 凭证 / 权限 / 服务端策略拒绝——重试必然同样失败，交由熔断器处理。 */
  denied: boolean;
  failure?: PushFailure;
  result: GitResult;
}

function runPush(
  dir: string,
  remote: string,
  branch: string,
  timeoutMs: number,
  dryRun: boolean
): PushOutcome {
  const args = dryRun
    ? ["push", "--dry-run", remote, `HEAD:${branch}`]
    : ["push", remote, `HEAD:${branch}`];
  const r = git(args, { cwd: dir, timeoutMs });
  if (r.code === 0) return { ok: true, rejected: false, denied: false, result: r };
  const failure = classifyPushFailure(r.stderr + r.stdout);
  return {
    ok: false,
    rejected: failure === "rejected",
    denied: failure === "denied",
    failure,
    result: r,
  };
}

export function push(
  dir: string,
  remote: string,
  branch: string,
  timeoutMs = 60000
): PushOutcome {
  return runPush(dir, remote, branch, timeoutMs, false);
}

/**
 * 只做写权限探测：不传输对象，但仍会向服务端发起 receive-pack 协商，
 * 鉴权在该阶段发生，因此即使本地无新提交也能真实反映写权限。
 */
export function pushDryRun(
  dir: string,
  remote: string,
  branch: string,
  timeoutMs = 30000
): PushOutcome {
  return runPush(dir, remote, branch, timeoutMs, true);
}

/** 是否配置了 origin 远端。 */
export function hasRemote(dir: string, remote: string): boolean {
  const r = git(["remote"], { cwd: dir });
  return r.code === 0 && r.stdout.split("\n").map((s) => s.trim()).includes(remote);
}

export function remoteUrl(dir: string, remote: string): string | null {
  const r = git(["remote", "get-url", remote], { cwd: dir });
  return r.code === 0 ? r.stdout.trim() : null;
}
