import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  tmpDir,
  g,
  makeOrigin,
  cloneWorkdir,
  mkConfig,
  makeMirrorOrigin,
  pushMirrorUpdate,
  write,
  read,
} from "./helpers.js";
import { syncOnce } from "../src/sync-engine.js";
import { Logger } from "../src/config.js";

function setup() {
  const root = tmpDir("mirror-sync");
  const bare = makeMirrorOrigin(root);
  const dir = path.join(root, "member");
  cloneWorkdir(bare, dir);
  const cfg = mkConfig(bare, dir);
  const logger = new Logger(path.join(root, "test.log"));
  return { root, bare, dir, cfg, logger };
}

describe("mirrorSyncOnce（经 syncOnce 自动分流）", () => {
  it("识别镜像仓库：不提交、不推送，本地改动被丢弃并上报", () => {
    const { dir, cfg, logger } = setup();
    write(dir, "docs/guide.md", "被本地篡改\n");
    write(dir, "rogue.md", "越权新增\n");
    const r = syncOnce(cfg, { logger });
    expect(r.mirror).toBe(true);
    expect(r.committed).toBe(false);
    expect(r.pushed).toBe(false);
    expect(r.discardedFiles.sort()).toEqual(["docs/guide.md", "rogue.md"]);
    expect(read(dir, "docs/guide.md")).toContain("feishu_url");
    expect(fs.existsSync(path.join(dir, "rogue.md"))).toBe(false);
  });

  it("拉取远端更新，同步后 md 文件为只读", () => {
    const { root, dir, cfg, logger } = setup();
    pushMirrorUpdate(root, "docs/new.md", "---\nfeishu_url: u\n---\n新文档\n");
    const r = syncOnce(cfg, { logger });
    expect(r.mirror).toBe(true);
    expect(r.merged).toBe(true);
    expect(read(dir, "docs/new.md")).toContain("新文档");
    const mode = fs.statSync(path.join(dir, "docs", "new.md")).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o444);
  });

  it("有人手动 commit 过（本地领先/分叉）：reset --hard 到远端，绝不外泄", () => {
    const { dir, cfg, logger } = setup();
    // 手动解锁并伪造一个本地提交
    fs.chmodSync(path.join(dir, "docs", "guide.md"), 0o644);
    write(dir, "docs/guide.md", "手动提交的内容\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-m", "手动越权提交");
    const r = syncOnce(cfg, { logger });
    expect(r.mirror).toBe(true);
    expect(r.pushed).toBe(false);
    expect(read(dir, "docs/guide.md")).toContain("feishu_url");
    // 本地 HEAD 已与远端一致
    const local = g(dir, "rev-parse", "HEAD").stdout.trim();
    const remote = g(dir, "rev-parse", "origin/main").stdout.trim();
    expect(local).toBe(remote);
  });

  it("暂停标记仍然生效", () => {
    const { dir, cfg, logger } = setup();
    write(dir, ".knowbase-pause", "");
    const r = syncOnce(cfg, { logger });
    expect(r.paused).toBe(true);
    expect(r.mirror).toBe(true);
  });

  it("经典仓库（无清单）不受影响：仍走上行路径", () => {
    const root = tmpDir("classic");
    const bare = makeOrigin(root); // makeOrigin 加进文件顶部的 helpers import
    const dir = path.join(root, "member");
    cloneWorkdir(bare, dir);
    write(dir, "note.md", "本地新增\n");
    const r = syncOnce(mkConfig(bare, dir), {
      logger: new Logger(path.join(root, "t.log")),
    });
    expect(r.mirror).toBe(false);
    expect(r.committed).toBe(true);
    expect(r.pushed).toBe(true);
  });
});
