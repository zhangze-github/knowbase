import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Logger, writeDaemonState, daemonStatePath } from "../src/config.js";
import { syncOnce, anotherDaemonRunning } from "../src/sync-engine.js";
import { stableNodePath } from "../src/platform/index.js";
import { buildBlock } from "../src/agent-config.js";
import {
  tmpDir,
  makeOrigin,
  cloneWorkdir,
  mkConfig,
  write,
  g,
} from "./helpers.js";

let root: string;
let bare: string;
let logger: Logger;

beforeEach(() => {
  root = tmpDir("fixes");
  bare = makeOrigin(root);
  logger = new Logger(path.join(root, "test.log"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const deps = () => ({ logger, hostname: "hostX" });

describe("P1: git 身份兜底", () => {
  it("完全无身份配置的机器上，commit/merge 仍然成功（临时身份）", () => {
    const A = path.join(root, "A");
    cloneWorkdir(bare, A);
    // 抹掉本仓库与全局/系统配置的身份来源
    g(A, "config", "--unset-all", "user.name");
    g(A, "config", "--unset-all", "user.email");
    const saved = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    try {
      write(A, "note.md", "no identity\n");
      const r = syncOnce(mkConfig(bare, A), deps());
      expect(r.committed).toBe(true);
      expect(r.pushed).toBe(true);
      // 提交作者是临时身份
      const who = spawnSync("git", ["log", "-1", "--format=%an <%ae>"], {
        cwd: A,
        encoding: "utf8",
        env: { ...process.env },
      }).stdout.trim();
      expect(who).toContain("knowbase");
    } finally {
      if (saved.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL;
      if (saved.GIT_CONFIG_SYSTEM === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = saved.GIT_CONFIG_SYSTEM;
    }
  });

  it("已配置身份的机器不受影响（不覆盖用户身份）", () => {
    const A = path.join(root, "A");
    cloneWorkdir(bare, A); // helpers 已设置 test/test@example.com
    write(A, "note.md", "with identity\n");
    const r = syncOnce(mkConfig(bare, A), deps());
    expect(r.committed).toBe(true);
    const who = g(A, "log", "-1", "--format=%an <%ae>").stdout.trim();
    expect(who).toBe("test <test@example.com>");
  });
});

describe("P2: stale index.lock 自愈", () => {
  it("超过 10 分钟的残留锁被自动清除，同步继续", () => {
    const A = path.join(root, "A");
    cloneWorkdir(bare, A);
    const lock = path.join(A, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(lock, old, old);

    write(A, "note.md", "after lock\n");
    const r = syncOnce(mkConfig(bare, A), deps());
    expect(fs.existsSync(lock)).toBe(false);
    expect(r.committed).toBe(true);
    expect(r.pushed).toBe(true);
  });

  it("新鲜的锁不动（可能是并发的正常 git 操作）", () => {
    const A = path.join(root, "A");
    cloneWorkdir(bare, A);
    const lock = path.join(A, ".git", "index.lock");
    fs.writeFileSync(lock, "");

    syncOnce(mkConfig(bare, A), deps());
    expect(fs.existsSync(lock)).toBe(true);
    fs.rmSync(lock);
  });
});

describe("P2: 守护进程单实例", () => {
  const restoreXdg = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (restoreXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = restoreXdg;
  });

  it("state 中 pid 存活且非自身 → 判定已有实例", () => {
    process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
    // 用测试进程自己的 pid 模拟「存活的另一个实例」
    writeDaemonState({ pid: process.pid, startedAt: new Date().toISOString() });
    expect(anotherDaemonRunning(999999)).toBe(true);
    // 自身 pid → 不算另一个实例
    expect(anotherDaemonRunning(process.pid)).toBe(false);
  });

  it("state 中 pid 已死 → 允许启动", () => {
    process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
    writeDaemonState({ pid: 999999, startedAt: new Date().toISOString() });
    expect(fs.existsSync(daemonStatePath())).toBe(true);
    expect(anotherDaemonRunning(process.pid)).toBe(false);
  });
});

describe("P1: 稳定 node 路径", () => {
  it("返回的路径真实存在且与 execPath 指向同一二进制", () => {
    const p = stableNodePath();
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.realpathSync(p)).toBe(fs.realpathSync(process.execPath));
  });
});

describe("提示词：组织/个人边界", () => {
  it("托管区块明确禁止个人内容进入知识库", () => {
    const block = buildBlock("/kb");
    expect(block).toContain("不进知识库");
    expect(block).toContain("个人偏好");
    expect(block).toContain("全组织共享");
    expect(block).toContain("先询问用户");
  });
});
