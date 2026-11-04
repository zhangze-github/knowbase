import { spawnSync, SpawnSyncOptions } from "node:child_process";

/**
 * knowbase 专用的 lark-cli profile。用独立 profile 而不是覆盖默认配置：
 * 成员本机可能已有个人的 lark-cli 应用与登录态，不能被 init 顶掉。
 * App Secret 只存在 lark-cli 的加密存储里，knowbase 配置只记 App ID。
 */
export const LARK_WRITE_PROFILE = "knowbase-writer";

/** 飞书 App ID 的合法字符；Windows 下经 shell 调用，这里同时是注入防线。 */
const APP_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidAppId(appId: string): boolean {
  return APP_ID_RE.test(appId);
}

function larkCli(args: string[], opts: SpawnSyncOptions = {}) {
  return spawnSync("lark-cli", args, {
    encoding: "utf8",
    // npm 在 Windows 上装的是 lark-cli.cmd，不经 shell 找不到
    shell: process.platform === "win32",
    ...opts,
  });
}

export function hasLarkCli(): boolean {
  return larkCli(["--version"]).status === 0;
}

/**
 * 把应用写入专用 profile。Secret 走 stdin，避免出现在进程列表里。
 * lark-cli 会当场向飞书校验凭证：校验失败时退出码非 0，但配置已经落盘，
 * 是否清理由调用方决定（见 removeLarkWriteProfile）。
 */
export function configureLarkWriteApp(
  appId: string,
  appSecret: string
): { ok: boolean; error?: string } {
  const args = ["config", "init", "--app-id", appId, "--app-secret-stdin", "--name", LARK_WRITE_PROFILE];
  // Agent 工作区内 lark-cli 默认拒绝 init；这里的应用是用户显式传入的
  if (process.env.HERMES_HOME || process.env.OPENCLAW_HOME) args.push("--force-init");
  const r = larkCli(args, { input: appSecret });
  if (r.status === 0) return { ok: true };
  const detail = `${r.stderr ?? ""}\n${r.stdout ?? ""}`.trim() || (r.error?.message ?? "未知错误");
  return { ok: false, error: detail.split(appSecret).join("***") };
}

function listProfileNames(): string[] {
  try {
    const list = JSON.parse(larkCli(["profile", "list"]).stdout as string) as { name: string }[];
    return list.map((p) => p.name);
  } catch {
    return [];
  }
}

/**
 * 清除专用 profile 及其加密存储的 Secret。
 * lark-cli 拒绝删除唯一的 profile，这种情况（平台环境的常态）只能走 config remove；
 * 它会清空全部配置，所以必须先确认本机确实只剩我们这一个。
 */
export function removeLarkWriteProfile(): boolean {
  const names = listProfileNames();
  const onlyOurs = names.length === 1 && names[0] === LARK_WRITE_PROFILE;
  const args = onlyOurs ? ["config", "remove"] : ["profile", "remove", LARK_WRITE_PROFILE];
  return larkCli(args).status === 0;
}
