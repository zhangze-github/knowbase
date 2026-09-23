import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir, makeMirrorOrigin, pushMirrorUpdate } from "./helpers.js";

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
  bare = makeMirrorOrigin(root);
});

afterEach(() => {
  if (daemon && !daemon.killed) daemon.kill("SIGKILL");
  daemon = null;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("守护进程：周期末刷新提示词与分发 skills", () => {


  it("新增文件后守护进程自动刷新 CLAUDE.md 中的区块", async () => {
    const kb = path.join(root, "kb");
    const init = spawnSync(
      "node",
      [CLI, "init", bare, "--dir", kb, "--interval", "5"],
      { encoding: "utf8", env: envFor() }
    );
    expect(init.status).toBe(0);

    // init clone 下来的镜像已带 docs/guide.md（种子）→ 区块应已含目录树
    const claude = path.join(home, ".claude", "CLAUDE.md");
    const initial = fs.readFileSync(claude, "utf8");
    expect(initial).toContain("### 知识库目录树");
    expect(initial).toContain("guide.md");

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

    // exporter 侧新增文档 → 轮询拉下来 → 周期末刷新区块，目录树随之更新
    pushMirrorUpdate(root, "角色定义.md", "---\nfeishu_url: https://x.feishu.cn/wiki/D2\n---\n\n# 角色定义\n");

    const refreshed = await waitFor(
      () => fs.readFileSync(claude, "utf8").includes("角色定义.md"),
      15000
    );
    expect(refreshed).toBe(true);
    expect(fs.readFileSync(claude, "utf8")).toContain("### 知识库目录树");
  }, 40000);

  it("新增团队 skill 后守护进程自动分发到 ~/.claude/skills", async () => {
    const kb = path.join(root, "kb");
    const init = spawnSync(
      "node",
      [CLI, "init", bare, "--dir", kb, "--interval", "5"],
      { encoding: "utf8", env: envFor() }
    );
    expect(init.status).toBe(0);

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

    // exporter 侧新增一个 skill → 轮询拉下来 → 周期末分发到 ~/.claude/skills。
    // 这条用例专门证明 refreshOrgSkills 真的被挂进了 runCycle：光测
    // refreshOrgSkills 本身（见 sync-engine.test.ts）测不出「有没有被调用」。
    // 必须从远端来：镜像目录只读，本地写入会在下个周期被丢弃。
    pushMirrorUpdate(
      root,
      "skills/demo/SKILL.md",
      "---\nname: demo\ndescription: d\n---\n\n步骤\n"
    );

    const skillMd = path.join(home, ".claude", "skills", "org-demo", "SKILL.md");
    const distributed = await waitFor(() => fs.existsSync(skillMd), 15000);
    expect(distributed).toBe(true);
    expect(fs.readFileSync(skillMd, "utf8")).toContain("name: org-demo");
  }, 40000);

});
