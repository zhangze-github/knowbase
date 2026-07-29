import { spawnSync, SpawnSyncOptions } from "node:child_process";

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

export function commit(dir: string, message: string): GitResult {
  return git(["commit", "-m", message], { cwd: dir });
}

/** 完成一次 merge 提交（沿用 git 准备好的 MERGE_MSG）。 */
export function commitNoEdit(dir: string): GitResult {
  return git(["commit", "--no-edit"], { cwd: dir });
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
  return git(["merge", "--no-edit", ref], { cwd: dir });
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

export interface PushOutcome {
  ok: boolean;
  /** 被拒（并发竞争 / non-fast-forward），下一周期先合并再推。 */
  rejected: boolean;
  result: GitResult;
}

export function push(
  dir: string,
  remote: string,
  branch: string,
  timeoutMs = 60000
): PushOutcome {
  const r = git(["push", remote, `HEAD:${branch}`], { cwd: dir, timeoutMs });
  if (r.code === 0) return { ok: true, rejected: false, result: r };
  const text = (r.stderr + r.stdout).toLowerCase();
  const rejected =
    text.includes("rejected") ||
    text.includes("non-fast-forward") ||
    text.includes("fetch first") ||
    text.includes("failed to push some refs");
  return { ok: false, rejected, result: r };
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
