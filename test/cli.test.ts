import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
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

function knowbase(args: string[], extraEnv: Record<string, string> = {}) {
  const res = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      KNOWBASE_SKIP_AUTOSTART: "1",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      ...extraEnv,
    },
  });
  return { code: res.status ?? 1, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

beforeEach(() => {
  root = tmpDir("cli");
  home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  bare = makeOrigin(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("CLI 端到端（真实运行 dist/cli.js）", () => {
  it("--version / --help", () => {
    const v = knowbase(["--version"]);
    expect(v.code).toBe(0);
    expect(v.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);

    const h = knowbase(["--help"]);
    expect(h.code).toBe(0);
    expect(h.out).toContain("init");
    expect(h.out).toContain("status");
    expect(h.out).toContain("uninstall");
    // daemon 为隐藏命令，不应出现在帮助中
    expect(h.out).not.toContain("daemon");
  });

  it("init → 种入规则、写配置、跳过自启", () => {
    const kb = path.join(root, "kb");
    const r = knowbase(["init", bare, "--dir", kb]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("接入完成");

    // 配置文件
    const cfgPath = path.join(home, ".config", "knowbase", "config.json");
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(cfg.repoUrl).toBe(bare);
    expect(cfg.dir).toBe(kb);

    // union 规则
    expect(fs.readFileSync(path.join(kb, ".gitattributes"), "utf8")).toContain(
      "*.md merge=union"
    );
    expect(fs.readFileSync(path.join(kb, ".gitignore"), "utf8")).toContain(
      ".knowbase-pause"
    );
  });

  it("init → 写文件 → sync 推送 → 另一 clone 可见", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    fs.writeFileSync(path.join(kb, "hello.md"), "hello world\n");
    const s = knowbase(["sync"]);
    expect(s.code).toBe(0);
    expect(s.out).toContain("已推送到远端");

    // 另一 clone 验证
    const other = path.join(root, "other");
    g(root, "clone", bare, other);
    expect(fs.existsSync(path.join(other, "hello.md"))).toBe(true);
  });

  it("pause 醒目显示 / resume 恢复", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    const p = knowbase(["pause"]);
    expect(p.code).toBe(0);
    expect(fs.existsSync(path.join(kb, ".knowbase-pause"))).toBe(true);

    const st = knowbase(["status"]);
    expect(st.out).toContain("已暂停");

    const rs = knowbase(["resume"]);
    expect(rs.code).toBe(0);
    expect(fs.existsSync(path.join(kb, ".knowbase-pause"))).toBe(false);
  });

  it("status 反映：守护进程未运行 + 冲突副本（AC4）", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    // 制造一个冲突副本文件
    fs.writeFileSync(
      path.join(kb, "note.conflict-hostZ-20260729T120000.txt"),
      "local version\n"
    );

    const st = knowbase(["status"]);
    // 守护进程未运行（测试未启动 daemon）
    expect(st.out).toContain("守护进程");
    expect(st.out).toContain("未运行");
    // 冲突副本被检出
    expect(st.out).toContain("冲突副本");
    expect(st.out).toContain("note.conflict-");
    // 有异常 → 退出码非 0
    expect(st.code).not.toBe(0);
  });

  it("uninstall 保留本地文件夹", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    const u = knowbase(["uninstall"]);
    expect(u.code).toBe(0);
    expect(u.out).toContain("保留");
    // 知识库目录仍在
    expect(fs.existsSync(kb)).toBe(true);
  });

  it("未接入时 status 给出引导", () => {
    const st = knowbase(["status"]);
    expect(st.code).toBe(0);
    expect(st.out).toContain("尚未接入");
  });
});
