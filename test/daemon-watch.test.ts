import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir, makeOrigin, g } from "./helpers.js";

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "cli.js"
);

let root: string;
let home: string;
let bare: string;
let daemon: ChildProcess | null = null;

const envFor = () => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  KNOWBASE_SKIP_AUTOSTART: "1",
  // 缩短防抖参数，让 e2e 在秒级完成
  KNOWBASE_QUIET_MS: "300",
  KNOWBASE_MAXWAIT_MS: "2000",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return cond();
}

beforeEach(() => {
  root = tmpDir("dwatch");
  home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  bare = makeOrigin(root);
});

afterEach(() => {
  if (daemon && !daemon.killed) daemon.kill("SIGKILL");
  daemon = null;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("守护进程：watch+防抖上行（轮询间隔 1 小时，只有监听能触发）", () => {
  it("写入文件后数秒内被自动推送，无需等轮询", async () => {
    const kb = path.join(root, "kb");
    // interval=3600：下一次轮询在 1 小时后，之后的推送只可能来自监听
    const init = spawnSync(
      "node",
      [CLI, "init", bare, "--dir", kb, "--interval", "3600"],
      { encoding: "utf8", env: envFor() }
    );
    expect(init.status).toBe(0);

    daemon = spawn("node", [CLI, "daemon"], { env: envFor(), stdio: "ignore" });

    // 等首轮同步完成（启动即跑一轮）
    const statePath = path.join(home, ".config", "knowbase", "daemon.state.json");
    const started = await waitFor(() => {
      try {
        return !!JSON.parse(fs.readFileSync(statePath, "utf8")).lastCycleAt;
      } catch {
        return false;
      }
    }, 10000);
    expect(started).toBe(true);

    // 首轮之后写入文件 → 只能靠监听触发同步
    fs.writeFileSync(path.join(kb, "watched.md"), "via watcher\n");

    const pushed = await waitFor(() => {
      const r = g(root, "--git-dir", bare, "ls-tree", "-r", "--name-only", "main");
      return r.stdout.includes("watched.md");
    }, 15000);
    expect(pushed).toBe(true);
  }, 40000);

  it("同步自身写盘不引发自触发风暴（远端改动合并后守护进程保持安静）", async () => {
    const kb = path.join(root, "kb");
    const init = spawnSync(
      "node",
      [CLI, "init", bare, "--dir", kb, "--interval", "5"],
      { encoding: "utf8", env: envFor() }
    );
    expect(init.status).toBe(0);

    // 另一个 clone 推送改动，让守护进程下一轮轮询合并（merge 会写工作区）
    const other = path.join(root, "other");
    g(root, "clone", bare, other);
    g(other, "config", "user.name", "t");
    g(other, "config", "user.email", "t@e.com");
    fs.writeFileSync(path.join(other, "remote.md"), "from other\n");
    g(other, "add", "-A");
    g(other, "commit", "-m", "remote change");
    g(other, "push", "origin", "HEAD:main");

    daemon = spawn("node", [CLI, "daemon"], { env: envFor(), stdio: "ignore" });

    // 等 merge 落地
    const merged = await waitFor(
      () => fs.existsSync(path.join(kb, "remote.md")),
      15000
    );
    expect(merged).toBe(true);

    // 稳定后统计本地 HEAD，静置数秒——若存在自触发风暴会产生新的空提交/异常
    await new Promise((r) => setTimeout(r, 4000));
    const head1 = g(kb, "rev-parse", "HEAD").stdout.trim();
    await new Promise((r) => setTimeout(r, 4000));
    const head2 = g(kb, "rev-parse", "HEAD").stdout.trim();
    expect(head2).toBe(head1);
  }, 40000);
});
