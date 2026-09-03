import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpDir } from "./helpers.js";
import {
  MIRROR_MANIFEST,
  isMirrorMode,
  readMirrorManifest,
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
