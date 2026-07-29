import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Config } from "../src/config.js";
import { DEFAULT_INTERVAL } from "../src/config.js";

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `knowbase-${prefix}-`));
}

/** 直接调 git（测试内部搭建用，带固定身份）。 */
export function g(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function setIdentity(dir: string): void {
  g(dir, "config", "user.name", "test");
  g(dir, "config", "user.email", "test@example.com");
}

/**
 * 搭建：一个 bare 远端 + 一个已推送初始内容（含 union 规则）的场景。
 * 返回 bare 仓库路径。
 */
export function makeOrigin(root: string): string {
  const bare = path.join(root, "origin.git");
  g(root, "init", "--bare", "-b", "main", bare);

  const seed = path.join(root, "seed");
  g(root, "clone", bare, seed);
  setIdentity(seed);
  fs.writeFileSync(path.join(seed, ".gitattributes"), "*.md merge=union\n");
  fs.writeFileSync(path.join(seed, ".gitignore"), ".knowbase-pause\n");
  fs.writeFileSync(path.join(seed, "README.md"), "# KB\n");
  g(seed, "add", "-A");
  g(seed, "commit", "-m", "init");
  g(seed, "push", "origin", "HEAD:main");
  return bare;
}

export function cloneWorkdir(bare: string, dir: string): void {
  const parent = path.dirname(dir);
  g(parent, "clone", bare, dir);
  setIdentity(dir);
}

export function mkConfig(bare: string, dir: string): Config {
  return {
    repoUrl: bare,
    dir,
    interval: DEFAULT_INTERVAL,
    branch: "main",
  };
}

export function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

export function write(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

export function listConflictCopies(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.includes(".conflict-"));
}
