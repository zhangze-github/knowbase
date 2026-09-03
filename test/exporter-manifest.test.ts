import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpDir } from "./helpers.js";
import { MIRROR_MANIFEST } from "../src/mirror.js";
import {
  newManifest,
  readExporterManifest,
  writeExporterManifest,
} from "../src/exporter/manifest.js";

describe("exporter manifest", () => {
  it("new → write → read 往返，文件名与成员侧一致", () => {
    const dir = tmpDir("em");
    const m = newManifest("spc123", "acme.feishu.cn", "https://acme.feishu.cn/wiki/Inbox1");
    m.nodes["nodeA"] = { path: "a.md", obj_edit_time: "100", hash: "h1" };
    writeExporterManifest(dir, m);
    expect(fs.existsSync(path.join(dir, MIRROR_MANIFEST))).toBe(true);
    const r = readExporterManifest(dir)!;
    expect(r.version).toBe(1);
    expect(r.space_id).toBe("spc123");
    expect(r.host).toBe("acme.feishu.cn");
    expect(r.agent_inbox_url).toContain("Inbox1");
    expect(r.nodes["nodeA"].hash).toBe("h1");
    // 成员侧契约字段可被成员侧读取
    expect(JSON.parse(fs.readFileSync(path.join(dir, MIRROR_MANIFEST), "utf8"))).toHaveProperty("version", 1);
  });

  it("缺失/损坏 → null", () => {
    const dir = tmpDir("em");
    expect(readExporterManifest(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, MIRROR_MANIFEST), "{broken");
    expect(readExporterManifest(dir)).toBeNull();
  });
});
