import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpDir, g, setIdentity, write, read } from "./helpers.js";
import {
  MIRROR_MANIFEST,
  isMirrorMode,
  readMirrorManifest,
  setMirrorLock,
  discardLocalChanges,
} from "../src/mirror.js";

describe("镜像清单与模式识别", () => {
  it("无清单文件：经典模式，manifest 为 null", () => {
    const dir = tmpDir("mirror");
    expect(isMirrorMode(dir)).toBe(false);
    expect(readMirrorManifest(dir)).toBeNull();
  });

  it("有合法清单：镜像模式，字段可读", () => {
    const dir = tmpDir("mirror");
    fs.writeFileSync(
      path.join(dir, MIRROR_MANIFEST),
      JSON.stringify({
        version: 1,
        last_sync_at: "2026-09-02T10:00:00+08:00",
        agent_inbox_url: "https://x.feishu.cn/wiki/AgentInbox123",
      })
    );
    expect(isMirrorMode(dir)).toBe(true);
    const m = readMirrorManifest(dir);
    expect(m?.last_sync_at).toBe("2026-09-02T10:00:00+08:00");
    expect(m?.agent_inbox_url).toBe("https://x.feishu.cn/wiki/AgentInbox123");
  });

  it("清单损坏：仍是镜像模式（防止误回经典模式上行），但 manifest 为 null", () => {
    const dir = tmpDir("mirror");
    fs.writeFileSync(path.join(dir, MIRROR_MANIFEST), "{ 不是 JSON");
    expect(isMirrorMode(dir)).toBe(true);
    expect(readMirrorManifest(dir)).toBeNull();
  });
});

describe("setMirrorLock 只读锁", () => {
  function mode(p: string): number {
    return fs.statSync(p).mode & 0o777;
  }

  it("锁定所有 md、返回计数，skills/ 与非 md 文件豁免", () => {
    const dir = tmpDir("lock");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skills", "org-a"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    fs.writeFileSync(path.join(dir, "sub", "b.md"), "b");
    fs.writeFileSync(path.join(dir, "skills", "org-a", "SKILL.md"), "s");
    fs.writeFileSync(path.join(dir, "note.txt"), "t");

    const n = setMirrorLock(dir, true);
    expect(n).toBe(2); // a.md + sub/b.md
    expect(mode(path.join(dir, "a.md"))).toBe(0o444);
    expect(mode(path.join(dir, "sub", "b.md"))).toBe(0o444);
    // skills/ 是 git 原生区（spec §8），保持可写
    expect(mode(path.join(dir, "skills", "org-a", "SKILL.md"))).not.toBe(0o444);
  });

  it("幂等：已锁定的文件第二次不计数；解锁恢复 0o644", () => {
    const dir = tmpDir("lock");
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    expect(setMirrorLock(dir, true)).toBe(1);
    expect(setMirrorLock(dir, true)).toBe(0);
    expect(setMirrorLock(dir, false)).toBe(1);
    expect(mode(path.join(dir, "a.md"))).toBe(0o644);
  });

  it.skipIf(process.platform === "win32")("锁定后直接写文件失败", () => {
    const dir = tmpDir("lock");
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    setMirrorLock(dir, true);
    expect(() => fs.writeFileSync(path.join(dir, "a.md"), "x")).toThrow();
  });
});

describe("discardLocalChanges", () => {
  function makeRepo(): string {
    const dir = tmpDir("discard");
    g(dir, "init", "-b", "main", ".");
    setIdentity(dir);
    write(dir, ".gitignore", ".knowbase-pause\n");
    write(dir, "a.md", "原文\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-m", "init");
    return dir;
  }

  it("恢复被改的跟踪文件、删除未跟踪文件，返回文件清单", () => {
    const dir = makeRepo();
    write(dir, "a.md", "被 agent 改坏\n");
    write(dir, "new-dir/rogue.md", "越权新增\n");
    const files = discardLocalChanges(dir);
    expect(files.sort()).toEqual(["a.md", "new-dir/rogue.md"]);
    expect(read(dir, "a.md")).toBe("原文\n");
    expect(fs.existsSync(path.join(dir, "new-dir"))).toBe(false);
  });

  it("暂停标记与被忽略文件不被清掉（已在 .gitignore）", () => {
    const dir = makeRepo();
    write(dir, ".knowbase-pause", "");
    write(dir, "b.md", "改动\n"); // 制造一个真实改动触发清理路径
    write(dir, "b2.md", "x\n");
    discardLocalChanges(dir);
    // .knowbase-pause 已被 .gitignore 忽略（clean 无 -x 不删），
    // 且 cleanUntracked 还带 -e 兜底 exporter 忘记种 .gitignore 的情况
    expect(fs.existsSync(path.join(dir, ".knowbase-pause"))).toBe(true);
  });

  it("暂停标记被保留但不计入返回列表（exporter 忘记 .gitignore）", () => {
    // 此场景：.gitignore 不含 .knowbase-pause，导致 changedFiles 会看到它
    const dir = tmpDir("discard-no-pause-gitignore");
    g(dir, "init", "-b", "main", ".");
    setIdentity(dir);
    // 故意不加 .knowbase-pause 进 .gitignore
    write(dir, ".gitignore", "");
    write(dir, "a.md", "原文\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-m", "init");

    // 写入暂停标记（此时会被 changedFiles 看到）与真实改动
    write(dir, ".knowbase-pause", "");
    write(dir, "c.md", "新增\n");
    const files = discardLocalChanges(dir);

    // 暂停标记被保留在磁盘上
    expect(fs.existsSync(path.join(dir, ".knowbase-pause"))).toBe(true);
    // 但不应计入返回列表（由 -e PAUSE_MARKER 与过滤共同保护）
    expect(files).not.toContain(".knowbase-pause");
    expect(files).toContain("c.md");
  });

  it("工作区干净时返回空数组", () => {
    const dir = makeRepo();
    expect(discardLocalChanges(dir)).toEqual([]);
  });
});
