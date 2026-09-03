import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpDir } from "./helpers.js";
import {
  MIRROR_MANIFEST,
  isMirrorMode,
  readMirrorManifest,
  setMirrorLock,
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
