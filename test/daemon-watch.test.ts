import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir, makeOrigin, g, denyPush } from "./helpers.js";

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

  it("索引变更后守护进程自动刷新 CLAUDE.md 中的区块", async () => {
    const kb = path.join(root, "kb");
    const init = spawnSync(
      "node",
      [CLI, "init", bare, "--dir", kb, "--interval", "3600"],
      { encoding: "utf8", env: envFor() }
    );
    expect(init.status).toBe(0);

    // init 时仓库还没有 index.md → 区块应是回退文案
    const claude = path.join(home, ".claude", "CLAUDE.md");
    expect(fs.readFileSync(claude, "utf8")).toContain("暂无");

    daemon = spawn("node", [CLI, "daemon"], { env: envFor(), stdio: "ignore" });

    const statePath = path.join(home, ".config", "knowbase", "daemon.state.json");
    const started = await waitFor(() => {
      try {
        return !!JSON.parse(fs.readFileSync(statePath, "utf8")).lastCycleAt;
      } catch {
        return false;
      }
    }, 10000);
    expect(started).toBe(true);

    // 写入索引 → 监听触发同步周期 → 周期末刷新区块
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n- 角色/：角色定义\n");

    const refreshed = await waitFor(
      () => fs.readFileSync(claude, "utf8").includes("角色定义"),
      15000
    );
    expect(refreshed).toBe(true);
    expect(fs.readFileSync(claude, "utf8")).toContain("### 知识库索引");
  }, 40000);

  it("暂停期间仍刷新提示词索引（刷新不碰 git，与 pause 语义无关）", async () => {
    const kb = path.join(root, "kb");
    const init = spawnSync(
      "node",
      [CLI, "init", bare, "--dir", kb, "--interval", "3600"],
      { encoding: "utf8", env: envFor() }
    );
    expect(init.status).toBe(0);

    // 暂停自动同步：git 侧应停手，提示词刷新仍须照常
    expect(spawnSync("node", [CLI, "pause"], { env: envFor() }).status).toBe(0);
    expect(fs.existsSync(path.join(kb, ".knowbase-pause"))).toBe(true);

    const claude = path.join(home, ".claude", "CLAUDE.md");
    expect(fs.readFileSync(claude, "utf8")).toContain("暂无");

    daemon = spawn("node", [CLI, "daemon"], { env: envFor(), stdio: "ignore" });
    const statePath = path.join(home, ".config", "knowbase", "daemon.state.json");
    const started = await waitFor(() => {
      try {
        return JSON.parse(fs.readFileSync(statePath, "utf8")).paused === true;
      } catch {
        return false;
      }
    }, 10000);
    expect(started).toBe(true);

    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n- 角色/：暂停期间的索引\n");
    const refreshed = await waitFor(
      () => fs.readFileSync(claude, "utf8").includes("暂停期间的索引"),
      15000
    );
    expect(refreshed).toBe(true);
    // git 侧确实没动：索引仍是未提交状态
    expect(g(kb, "status", "--porcelain").stdout).toContain("index.md");
  }, 40000);
});

describe("守护进程：push 熔断跨周期保持", () => {
  it("熔断状态在多个周期间由同一个 gate 持有，since 不因新周期而重置", async () => {
    const kb = path.join(root, "kb");
    // interval 拉大到 3600：轮询本身不会触发周期，两轮都只靠文件监听触发，
    // 避免真实等 5 分钟的 PROBE_INTERVAL_MS 探测窗口，测试可以跑得很快。
    const init = spawnSync(
      "node",
      [CLI, "init", bare, "--dir", kb, "--interval", "3600"],
      { encoding: "utf8", env: envFor() }
    );
    expect(init.status).toBe(0);

    // 远端只保留读权限：pre-receive 钩子对任何 push 都拒绝
    denyPush(bare);

    // daemon 启动前先制造一次本地改动，保证启动即执行的首轮周期就会尝试 push 并被拒
    fs.writeFileSync(path.join(kb, "first.md"), "first change\n");

    daemon = spawn("node", [CLI, "daemon"], { env: envFor(), stdio: "ignore" });

    const statePath = path.join(home, ".config", "knowbase", "daemon.state.json");
    const readState = (): any => {
      try {
        return JSON.parse(fs.readFileSync(statePath, "utf8"));
      } catch {
        return null;
      }
    };

    // 首轮：等 pushBlocked 落盘
    const blockedOnce = await waitFor(() => !!readState()?.pushBlocked, 10000);
    expect(blockedOnce).toBe(true);
    const state1 = readState();
    const since1: string = state1.pushBlocked.since;
    const lastCycleAt1: string | undefined = state1.lastCycleAt;
    expect(since1).toBeTruthy();

    // 二轮：靠文件监听再触发一次周期。PROBE_INTERVAL_MS 是 5 分钟，这两轮之间
    // 不会真的再探测一次，第二轮的 push 应静默跳过——这正是我们要验证的场景：
    // 若 runCycle 误把 `new PushGate()` 挪到内部（每轮新建），熔断会失效，
    // 第二轮会当作「首次」重新尝试 push 并把 since 重置为本轮时刻。
    fs.writeFileSync(path.join(kb, "second.md"), "second change\n");
    const cycled = await waitFor(() => {
      const s = readState();
      return !!s && s.lastCycleAt !== lastCycleAt1;
    }, 10000);
    expect(cycled).toBe(true);

    const state2 = readState();
    // 断言 1：连跑至少两个周期后，状态文件里仍带 pushBlocked。
    expect(state2.pushBlocked).toBeTruthy();
    // 断言 2：两轮之间 since 不变——这条才是真正能抓住「每轮新建 gate」退化的断言。
    expect(state2.pushBlocked.since).toBe(since1);
  }, 20000);
});
