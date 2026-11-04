import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir, makeMirrorOrigin } from "./helpers.js";
import { buildBlock } from "../src/agent-config.js";
import { refreshAgentPrompts } from "../src/sync-engine.js";
import { Logger, type Config } from "../src/config.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const SECRET = "super-secret-value";

let root: string;
let home: string;
let bin: string;
let calls: string;
let bare: string;
let kb: string;

/** 假 lark-cli：记录 argv 与 stdin，退出码由 FAKE_LARK_INIT_RC 控制；FAKE_LARK_ONLY_PROFILE 模拟本机只有专用 profile。 */
function installFakeLarkCli(): void {
  fs.writeFileSync(
    path.join(bin, "lark-cli"),
    `#!/bin/sh
[ "$1" = "--version" ] && exit 0
if [ "$1" = "profile" ] && [ "$2" = "list" ]; then
  if [ -n "$FAKE_LARK_ONLY_PROFILE" ]; then echo '[{"name":"knowbase-writer"}]'; else echo '[{"name":"personal"},{"name":"knowbase-writer"}]'; fi
  exit 0
fi
if [ "$1" = "profile" ] && [ -n "$FAKE_LARK_ONLY_PROFILE" ]; then echo "cannot remove the only profile" >&2; exit 2; fi
if [ "$1" = "config" ] && [ "$2" = "init" ]; then
  echo "init $* stdin=$(cat)" >> "${calls}"
  if [ -n "$FAKE_LARK_INIT_RC" ]; then echo "invalid_client $FAKE_LARK_ECHO" >&2; exit "$FAKE_LARK_INIT_RC"; fi
  exit 0
fi
echo "$*" >> "${calls}"
exit 0
`,
    { mode: 0o755 }
  );
}

function knowbase(args: string[], extraEnv: Record<string, string> = {}, withLark = true) {
  const res = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: withLark ? `${bin}:${process.env.PATH}` : emptyLarkPath(),
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      KNOWBASE_SKIP_AUTOSTART: "1",
      KNOWBASE_LARK_APP_ID: "",
      KNOWBASE_LARK_APP_SECRET: "",
      HERMES_HOME: "",
      OPENCLAW_HOME: "",
      ...extraEnv,
    },
  });
  return { code: res.status ?? 1, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

/** 去掉 PATH 中含真实 lark-cli 的目录，模拟未安装。 */
function emptyLarkPath(): string {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((d) => !fs.existsSync(path.join(d, "lark-cli")))
    .join(path.delimiter);
}

const cfgPath = () => path.join(home, ".config", "knowbase", "config.json");
const readCfg = () => JSON.parse(fs.readFileSync(cfgPath(), "utf8"));
const claudeMd = () => fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
const larkCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "");

beforeEach(() => {
  root = tmpDir("lark-write-app");
  home = path.join(root, "home");
  bin = path.join(root, "bin");
  calls = path.join(root, "lark-calls.log");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  installFakeLarkCli();
  bare = makeMirrorOrigin(root);
  kb = path.join(root, "kb");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("init 传入飞书写入应用", () => {
  it("凭证走 stdin 进专用 profile，提示词引导应用身份，Secret 不进配置和提示词", () => {
    const r = knowbase(["init", bare, "--dir", kb, "--app-id", "cli_abc", "--app-secret", SECRET]);
    expect(r.code).toBe(0);
    expect(larkCalls()).toContain(
      `init config init --app-id cli_abc --app-secret-stdin --name knowbase-writer stdin=${SECRET}`
    );
    expect(readCfg().larkAppId).toBe("cli_abc");
    expect(claudeMd()).toContain("--profile knowbase-writer --as bot");

    const logFile = path.join(home, ".config", "knowbase", "knowbase.log");
    for (const text of [fs.readFileSync(cfgPath(), "utf8"), claudeMd(), r.out, fs.readFileSync(logFile, "utf8")]) {
      expect(text).not.toContain(SECRET);
    }
  });

  it("支持从环境变量读取凭证", () => {
    const r = knowbase(["init", bare, "--dir", kb], {
      KNOWBASE_LARK_APP_ID: "cli_env",
      KNOWBASE_LARK_APP_SECRET: SECRET,
    });
    expect(r.code).toBe(0);
    expect(larkCalls()).toContain("--app-id cli_env");
    expect(readCfg().larkAppId).toBe("cli_env");
  });

  it("不传凭证时不碰 lark-cli，提示词保持个人身份", () => {
    const r = knowbase(["init", bare, "--dir", kb]);
    expect(r.code).toBe(0);
    expect(larkCalls()).toBe("");
    expect(readCfg().larkAppId).toBeUndefined();
    expect(claudeMd()).not.toContain("knowbase-writer");
  });

  it("只传一半凭证时直接失败，不 clone", () => {
    const r = knowbase(["init", bare, "--dir", kb, "--app-id", "cli_abc"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("--app-secret");
    expect(fs.existsSync(kb)).toBe(false);
  });

  it("拒绝含非法字符的 App ID", () => {
    const r = knowbase(["init", bare, "--dir", kb, "--app-id", "cli;rm -rf", "--app-secret", SECRET]);
    expect(r.code).toBe(1);
    expect(larkCalls()).toBe("");
  });

  it("未安装 lark-cli 时失败并给出安装指引，不退回个人身份接入", () => {
    const r = knowbase(["init", bare, "--dir", kb, "--app-id", "cli_abc", "--app-secret", SECRET], {}, false);
    expect(r.code).toBe(1);
    expect(r.out).toContain("lark-cli");
    expect(fs.existsSync(cfgPath())).toBe(false);
  });

  it("凭证校验失败：init 失败、清掉无效 profile、输出中打码 Secret", () => {
    const r = knowbase(["init", bare, "--dir", kb, "--app-id", "cli_abc", "--app-secret", SECRET], {
      FAKE_LARK_INIT_RC: "3",
      FAKE_LARK_ECHO: SECRET,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("invalid_client");
    expect(r.out).not.toContain(SECRET);
    expect(larkCalls()).toContain("profile remove knowbase-writer");
    expect(fs.existsSync(cfgPath())).toBe(false);
  });

  it("已接入机器换凭证失败时保留原 profile 和配置", () => {
    expect(knowbase(["init", bare, "--dir", kb, "--app-id", "cli_abc", "--app-secret", SECRET]).code).toBe(0);
    const r = knowbase(["init", bare, "--dir", kb, "--app-id", "cli_new", "--app-secret", "x"], {
      FAKE_LARK_INIT_RC: "3",
    });
    expect(r.code).toBe(1);
    expect(larkCalls()).not.toContain("profile remove");
    expect(readCfg().larkAppId).toBe("cli_abc");
  });

  it("重跑 init 不带凭证时沿用应用，不退回个人身份", () => {
    expect(knowbase(["init", bare, "--dir", kb, "--app-id", "cli_abc", "--app-secret", SECRET]).code).toBe(0);
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(readCfg().larkAppId).toBe("cli_abc");
    expect(claudeMd()).toContain("knowbase-writer");
  });

  it("status 显示写入身份，uninstall 清除 profile", () => {
    expect(knowbase(["init", bare, "--dir", kb, "--app-id", "cli_abc", "--app-secret", SECRET]).code).toBe(0);
    expect(knowbase(["status"]).out).toContain("飞书应用 cli_abc");
    const r = knowbase(["uninstall"]);
    expect(r.code).toBe(0);
    expect(larkCalls()).toContain("profile remove knowbase-writer");
  });

  it("专用 profile 是本机唯一 profile 时，uninstall 走 config remove 清除凭证", () => {
    expect(knowbase(["init", bare, "--dir", kb, "--app-id", "cli_abc", "--app-secret", SECRET]).code).toBe(0);
    const r = knowbase(["uninstall"], { FAKE_LARK_ONLY_PROFILE: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("已清除飞书写入应用凭证");
    expect(larkCalls()).toContain("config remove");
    expect(larkCalls()).not.toContain("profile remove");
  });

  it("本机还有其他 profile 时绝不走 config remove", () => {
    expect(knowbase(["init", bare, "--dir", kb, "--app-id", "cli_abc", "--app-secret", SECRET]).code).toBe(0);
    expect(knowbase(["uninstall"]).code).toBe(0);
    expect(larkCalls()).not.toContain("config remove");
  });

  it("未配置应用的 uninstall 不碰 lark-cli 的 profile", () => {
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(knowbase(["uninstall"]).code).toBe(0);
    expect(larkCalls()).toBe("");
  });
});

describe("提示词中的写入身份", () => {
  it("默认不出现，开启后位于写入规则内", () => {
    expect(buildBlock("/kb")).not.toContain("--as bot");
    const b = buildBlock("/kb", null, true);
    expect(b).toContain("--profile knowbase-writer --as bot");
    expect(b.indexOf("写入身份")).toBeGreaterThan(b.indexOf("**写（重要"));
  });

  it("守护进程周期刷新不会把应用身份改回个人身份", () => {
    expect(knowbase(["init", bare, "--dir", kb, "--app-id", "cli_abc", "--app-secret", SECRET]).code).toBe(0);
    const cfg: Config = { repoUrl: bare, dir: kb, interval: 60, branch: "main", larkAppId: "cli_abc" };
    fs.chmodSync(path.join(kb, "docs"), 0o755);
    fs.writeFileSync(path.join(kb, "docs", "new.md"), "# 新文档\n");
    refreshAgentPrompts(cfg, new Logger(path.join(root, "t.log")), home);
    const md = claudeMd();
    expect(md).toContain("new.md");
    expect(md).toContain("--profile knowbase-writer --as bot");
  });
});
