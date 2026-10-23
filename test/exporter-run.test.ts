import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpDir, g, makeEmptyOrigin, cloneWorkdir, read, denyPush, allowPush } from "./helpers.js";
import { Logger } from "../src/config.js";
import { readExporterManifest, writeExporterManifest } from "../src/exporter/manifest.js";
import type { WikiNode } from "../src/exporter/tree-diff.js";
import type { DocxBlock } from "../src/exporter/lark-client.js";
import { runExportOnce, ExporterConfig, LarkClientLike, tryMoveNode } from "../src/exporter/exporter.js";

function node(p: Partial<WikiNode>): WikiNode {
  return {
    node_token: "tok",
    obj_token: "obj",
    obj_type: "docx",
    parent_node_token: "",
    title: "标题",
    obj_edit_time: "100",
    has_child: false,
    ...p,
  };
}

/** 一个 Page 块 + 一个 Text 块的最简 docx（与 docx-md.ts 的 BlockType 对齐）。 */
function textBlocks(content: string): DocxBlock[] {
  return [
    { block_id: "page", block_type: 1, children: ["t1"] },
    { block_id: "t1", block_type: 2, parent_id: "page", text: { elements: [{ text_run: { content } }] } },
  ];
}

/**
 * 内存版 LarkClientLike：nodes/blocksByObjToken 均可在测试用例里改写模拟「下一轮」，
 * failTokens 模拟单篇拉取失败，calls 记录 listDocBlocks 的调用顺序供 Task 7
 * 「只重导变化节点」用例验证没有多拉未变化节点的 blocks。
 */
class FakeClient implements LarkClientLike {
  failTokens = new Set<string>();
  calls: string[] = [];
  constructor(
    public nodes: WikiNode[],
    public blocksByObjToken: Record<string, DocxBlock[]>
  ) {}
  async listAllSpaceNodes(): Promise<WikiNode[]> {
    return this.nodes;
  }
  async listDocBlocks(documentId: string): Promise<DocxBlock[]> {
    this.calls.push(documentId);
    if (this.failTokens.has(documentId)) throw new Error("拉取 blocks 失败（模拟）");
    return this.blocksByObjToken[documentId] ?? [];
  }
}

function quietLogger(dir: string): Logger {
  return new Logger(path.join(dir, "test.log"));
}

describe("runExportOnce", () => {
  it("首轮全量：3 节点落盘、frontmatter 正确、manifest 3 项、已 commit 并推到 bare", async () => {
    const root = tmpDir("exp1");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const P = node({ node_token: "P", obj_token: "oP", title: "指南", has_child: true });
    const C = node({ node_token: "C", obj_token: "oC", title: "部署", parent_node_token: "P" });
    const T = node({ node_token: "T", obj_token: "oT", title: "FAQ" });
    const client = new FakeClient([P, C, T], {
      oP: textBlocks("指南正文"),
      oC: textBlocks("部署正文"),
      oT: textBlocks("FAQ正文"),
    });

    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const now = () => new Date("2026-09-03T00:00:00.000Z");
    const result = await runExportOnce(cfg, { client, logger: quietLogger(root), now });

    expect(result.error).toBeUndefined();
    expect(result.exported).toBe(3);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);

    expect(fs.existsSync(path.join(dir, "指南", "指南.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "指南", "部署.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "FAQ.md"))).toBe(true);

    expect(read(dir, "指南/指南.md").startsWith("---\nfeishu_url: https://acme.feishu.cn/wiki/P")).toBe(true);
    expect(read(dir, "指南/部署.md").startsWith("---\nfeishu_url: https://acme.feishu.cn/wiki/C")).toBe(true);
    expect(read(dir, "FAQ.md").startsWith("---\nfeishu_url: https://acme.feishu.cn/wiki/T")).toBe(true);

    const manifest = readExporterManifest(dir)!;
    expect(Object.keys(manifest.nodes).sort()).toEqual(["C", "P", "T"]);
    expect(manifest.last_sync_at).toBeTruthy();

    const logRes = g(bare, "log", "--format=%s", "-1");
    expect(logRes.stdout.trim()).toContain("mirror: +3");
  });

  it("非 docx 节点：占位正文也带 frontmatter", async () => {
    const root = tmpDir("exp2");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const S = node({ node_token: "S", obj_token: "oS", obj_type: "sheet", title: "表格" });
    const client = new FakeClient([S], {});
    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const result = await runExportOnce(cfg, { client, logger: quietLogger(root) });

    expect(result.error).toBeUndefined();
    expect(result.exported).toBe(1);
    const content = read(dir, "表格.md");
    expect(content.startsWith("---\nfeishu_url: https://acme.feishu.cn/wiki/S")).toBe(true);
    expect(content).toContain("此为飞书 sheet");
    expect(content).toContain("原文");
  });

  it("单篇 blocks 拉取失败：该篇跳过（无文件、manifest 无该节点），其余成功，result.error 为空", async () => {
    const root = tmpDir("exp3");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const A = node({ node_token: "A", obj_token: "oA", title: "甲" });
    const B = node({ node_token: "B", obj_token: "oB", title: "乙" });
    const Bad = node({ node_token: "Z", obj_token: "oZ", title: "坏文档" });
    const client = new FakeClient([A, B, Bad], {
      oA: textBlocks("甲正文"),
      oB: textBlocks("乙正文"),
    });
    client.failTokens.add("oZ");

    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const result = await runExportOnce(cfg, { client, logger: quietLogger(root) });

    expect(result.error).toBeUndefined();
    expect(result.exported).toBe(2);
    expect(fs.existsSync(path.join(dir, "坏文档.md"))).toBe(false);

    const manifest = readExporterManifest(dir)!;
    expect(manifest.nodes["Z"]).toBeUndefined();
    expect(Object.keys(manifest.nodes).sort()).toEqual(["A", "B"]);
  });
});

/**
 * 每次调用推进 1ms 的时钟，供「多轮无内容变化」的用例使用：manifest.last_sync_at
 * 靠这个持续前进才会产生 git 层面的改动（heartbeat 提交）——如果多轮都用同一个
 * 固定 Date，manifest 文件内容跨轮完全不变，hasChanges() 恒为 false，round 直接
 * 不提交，而不是产出预期中的 heartbeat 提交。
 */
function ticker(startIso = "2026-09-03T00:00:00.000Z"): () => Date {
  let t = Date.parse(startIso);
  return () => new Date(t++);
}

describe("增量周期与全量对账", () => {
  it("第二轮无任何节点变化 → 只有心跳提交，exported=0", async () => {
    const root = tmpDir("exp7-heartbeat");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const A = node({ node_token: "A", obj_token: "oA", title: "甲" });
    const client = new FakeClient([A], { oA: textBlocks("甲正文") });
    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const now = ticker();

    const r1 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(r1.error).toBeUndefined();

    const r2 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(r2.error).toBeUndefined();
    expect(r2.exported).toBe(0);
    expect(r2.moved).toBe(0);
    expect(r2.removed).toBe(0);
    expect(r2.committed).toBe(true);

    const msg = g(bare, "log", "--format=%s", "-1").stdout.trim();
    expect(msg).toBe("mirror: heartbeat");
  });

  it("单节点 obj_edit_time+blocks 变化 → 只重导该篇，不拉取未变化节点的 blocks", async () => {
    const root = tmpDir("exp7-partial");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const A = node({ node_token: "A", obj_token: "oA", title: "甲" });
    const B = node({ node_token: "B", obj_token: "oB", title: "乙" });
    const client = new FakeClient([A, B], { oA: textBlocks("甲正文"), oB: textBlocks("乙正文") });
    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const now = () => new Date("2026-09-03T00:00:00.000Z");

    await runExportOnce(cfg, { client, logger: quietLogger(root), now });

    client.calls.length = 0;
    client.nodes = [{ ...A, obj_edit_time: "200" }, B];
    client.blocksByObjToken["oA"] = textBlocks("甲正文-改");

    const r2 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(r2.error).toBeUndefined();
    expect(r2.exported).toBe(1);
    expect(client.calls).toEqual(["oA"]);
    expect(read(dir, "甲.md")).toContain("甲正文-改");
  });

  it("改标题（edit_time 不变）→ git mv，提交消息含移动计数，exported=0 moved=1", async () => {
    const root = tmpDir("exp7-move");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const A = node({ node_token: "A", obj_token: "oA", title: "旧标题" });
    const client = new FakeClient([A], { oA: textBlocks("正文") });
    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const now = () => new Date("2026-09-03T00:00:00.000Z");

    await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(fs.existsSync(path.join(dir, "旧标题.md"))).toBe(true);

    client.nodes = [{ ...A, title: "新标题" }];
    const r2 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });

    expect(r2.error).toBeUndefined();
    expect(r2.exported).toBe(0);
    expect(r2.moved).toBe(1);
    expect(fs.existsSync(path.join(dir, "旧标题.md"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "新标题.md"))).toBe(true);
    // 纯移动不重渲染内容（exported=0），但 frontmatter 结构应完好保留
    const content = read(dir, "新标题.md");
    expect(content.startsWith("---\nfeishu_url: https://acme.feishu.cn/wiki/A")).toBe(true);
    expect(content).toContain("managed_by: knowbase-mirror");
    expect(content).toContain("正文");

    const msg = g(bare, "log", "--format=%s", "-1").stdout.trim();
    expect(msg).toContain("→1");
  });

  it("新增+移动同轮 → 提交消息同时含新增与移动段", async () => {
    const root = tmpDir("exp7-move-msg");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const A = node({ node_token: "A", obj_token: "oA", title: "旧标题" });
    const client = new FakeClient([A], { oA: textBlocks("正文") });
    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const now = () => new Date("2026-09-03T00:00:00.000Z");

    await runExportOnce(cfg, { client, logger: quietLogger(root), now });

    const B = node({ node_token: "B", obj_token: "oB", title: "新节点" });
    client.nodes = [{ ...A, title: "新标题" }, B];
    client.blocksByObjToken["oB"] = textBlocks("新节点正文");
    await runExportOnce(cfg, { client, logger: quietLogger(root), now });

    const msg = g(bare, "log", "--format=%s", "-1").stdout.trim();
    expect(msg).toBe("mirror: +1 →1");
  });

  it("删除节点 → 文件删除、manifest 清项、空目录被清理", async () => {
    const root = tmpDir("exp7-remove");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const P = node({ node_token: "P", obj_token: "oP", title: "父", has_child: true });
    const C = node({ node_token: "C", obj_token: "oC", title: "子", parent_node_token: "P" });
    const client = new FakeClient([P, C], { oP: textBlocks("父正文"), oC: textBlocks("子正文") });
    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const now = () => new Date("2026-09-03T00:00:00.000Z");

    await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(fs.existsSync(path.join(dir, "父", "父.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "父", "子.md"))).toBe(true);

    client.nodes = []; // 整棵子树被删除
    const r2 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });

    expect(r2.error).toBeUndefined();
    expect(r2.removed).toBe(2);
    expect(fs.existsSync(path.join(dir, "父"))).toBe(false);

    const manifest = readExporterManifest(dir)!;
    expect(Object.keys(manifest.nodes)).toEqual([]);
  });

  it("manifest 缺 last_full_check_at → 触发全量对账，hash 相同不写盘", async () => {
    const root = tmpDir("exp7-full-missing");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const A = node({ node_token: "A", obj_token: "oA", title: "甲" });
    const client = new FakeClient([A], { oA: textBlocks("甲正文") });
    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const now = () => new Date("2026-09-03T00:00:00.000Z");

    await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    const before = read(dir, "甲.md");

    // 模拟旧版本 manifest：没有 last_full_check_at 字段
    const manifest = readExporterManifest(dir)!;
    delete manifest.last_full_check_at;
    writeExporterManifest(dir, manifest);
    g(dir, "add", "-A");
    g(dir, "commit", "-m", "模拟旧 manifest");

    const r2 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(r2.error).toBeUndefined();
    expect(r2.exported).toBe(0); // hash 相同：不算变更
    expect(read(dir, "甲.md")).toBe(before); // 未重写

    const manifest2 = readExporterManifest(dir)!;
    expect(manifest2.last_full_check_at).toBeTruthy();
  });

  it("连续两轮全量对账（fullCheckMs=0）→ 第二轮零内容变更（幂等），last_full_check_at 持续推进", async () => {
    const root = tmpDir("exp7-full-idem");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const A = node({ node_token: "A", obj_token: "oA", title: "甲" });
    const client = new FakeClient([A], { oA: textBlocks("甲正文") });
    const cfg: ExporterConfig = {
      repoDir: dir,
      branch: "main",
      spaceId: "spc1",
      host: "acme.feishu.cn",
      fullCheckMs: 0,
    };
    const now = ticker();

    await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    const t1 = readExporterManifest(dir)!.last_full_check_at;
    expect(t1).toBeTruthy();

    const r2 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(r2.error).toBeUndefined();
    expect(r2.exported).toBe(0);

    const r3 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(r3.error).toBeUndefined();
    expect(r3.exported).toBe(0);
    expect(r3.moved).toBe(0);
    expect(r3.removed).toBe(0);

    const msg = g(bare, "log", "--format=%s", "-1").stdout.trim();
    expect(msg).toBe("mirror: heartbeat");
  });

  it("push 失败后本地领先且 result.error 非空；恢复权限后补推积压提交", async () => {
    const root = tmpDir("exp7-push-recover");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const A = node({ node_token: "A", obj_token: "oA", title: "甲" });
    const client = new FakeClient([A], { oA: textBlocks("甲正文") });
    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const now = ticker();

    denyPush(bare);
    const r1 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(r1.committed).toBe(true);
    expect(r1.pushed).toBe(false);
    expect(r1.error).toBeTruthy();

    const ahead1 = parseInt(g(dir, "rev-list", "--count", "origin/main..HEAD").stdout.trim(), 10);
    expect(ahead1).toBe(1);

    const r2 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(r2.committed).toBe(true);
    expect(r2.pushed).toBe(false);
    expect(r2.error).toBeTruthy();

    allowPush(bare);
    const r3 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(r3.error).toBeUndefined();
    expect(r3.pushed).toBe(true);

    const localHead = g(dir, "rev-parse", "HEAD").stdout.trim();
    const bareHead = g(bare, "rev-parse", "main").stdout.trim();
    expect(bareHead).toBe(localHead);
  });

  it("未配置 Git 身份时，仍能合并远端 Skill 与积压导出并保留双方内容", async () => {
    const root = tmpDir("exp-remote-skills");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "exporter");
    cloneWorkdir(bare, dir);
    g(dir, "config", "user.name", "");
    g(dir, "config", "user.email", "");
    const A = node({ node_token: "A", obj_token: "oA", title: "指南" });
    const client = new FakeClient([A], { oA: textBlocks("初始正文") });
    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const now = ticker();
    expect((await runExportOnce(cfg, { client, logger: quietLogger(root), now })).pushed).toBe(true);

    denyPush(bare);
    A.obj_edit_time = "200";
    client.blocksByObjToken.oA = textBlocks("尚未推送的知识正文");
    expect((await runExportOnce(cfg, { client, logger: quietLogger(root), now })).pushed).toBe(false);
    allowPush(bare);
    const other = path.join(root, "maintainer");
    cloneWorkdir(bare, other);
    fs.mkdirSync(path.join(other, "skills/example"), { recursive: true });
    fs.writeFileSync(path.join(other, "skills/example/SKILL.md"), "团队新技能\n");
    g(other, "add", "-A");
    g(other, "commit", "-m", "update team skill");
    expect(g(other, "push", "origin", "HEAD:main").code).toBe(0);
    const remoteSkillCommit = g(other, "rev-parse", "HEAD").stdout.trim();
    const pendingExportCommit = g(dir, "rev-parse", "HEAD").stdout.trim();

    A.obj_edit_time = "300";
    client.blocksByObjToken.oA = textBlocks("飞书最新正文");
    const result = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(result.error).toBeUndefined();
    expect(result.pushed).toBe(true);
    expect(g(bare, "show", "main:skills/example/SKILL.md").stdout).toBe("团队新技能\n");
    expect(g(bare, "show", "main:指南.md").stdout).toContain("飞书最新正文");
    expect(g(bare, "merge-base", "--is-ancestor", remoteSkillCommit, "main").code).toBe(0);
    expect(g(bare, "merge-base", "--is-ancestor", pendingExportCommit, "main").code).toBe(0);
    expect(g(dir, "status", "--porcelain").stdout).toBe("");
  });

  it("远端与积压正文冲突时停止导出并中止合并，不遗留冲突状态", async () => {
    const root = tmpDir("exp-remote-conflict");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "exporter");
    cloneWorkdir(bare, dir);
    const A = node({ node_token: "A", obj_token: "oA", title: "指南" });
    const client = new FakeClient([A], { oA: textBlocks("初始正文") });
    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const now = ticker();
    await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    const other = path.join(root, "other");
    cloneWorkdir(bare, other);
    denyPush(bare);
    A.obj_edit_time = "200";
    client.blocksByObjToken.oA = textBlocks("本地待推正文");
    await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    allowPush(bare);
    fs.writeFileSync(path.join(other, "指南.md"), "另一个写入者的正文\n");
    g(other, "add", "-A");
    g(other, "commit", "-m", "conflicting mirror write");
    expect(g(other, "push", "origin", "HEAD:main").code).toBe(0);
    const pendingHead = g(dir, "rev-parse", "HEAD").stdout.trim();
    const manifestBefore = read(dir, ".knowbase-mirror.json");

    const result = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
    expect(result.error).toContain("合并远端失败");
    expect(result.pushed).toBe(false);
    expect(g(dir, "rev-parse", "HEAD").stdout.trim()).toBe(pendingHead);
    expect(g(dir, "rev-parse", "--verify", "MERGE_HEAD").code).not.toBe(0);
    expect(g(dir, "status", "--porcelain").stdout).toBe("");
    expect(read(dir, ".knowbase-mirror.json")).toBe(manifestBefore);
    expect(read(dir, "指南.md")).toContain("本地待推正文");
    expect(g(bare, "show", "main:指南.md").stdout).toBe("另一个写入者的正文\n");
  });

  // chmod 语义在 Windows 上不可靠（ACL 而非 rwx 位），无法保证真实阻断 rename/unlink，
  // 与仓库里 mirror.test.ts / skills-sync.test.ts 的既有惯例一致，跳过而非伪造通过。
  it.skipIf(process.platform === "win32")(
    "移动失败（源目录不可写）→ 不产生孤儿文件，节点留待下轮重试",
    async () => {
      const root = tmpDir("exp7-move-fail");
      const bare = makeEmptyOrigin(root);
      const dir = path.join(root, "work");
      cloneWorkdir(bare, dir);

      const P = node({ node_token: "P", obj_token: "oP", title: "父", has_child: true });
      const C = node({ node_token: "C", obj_token: "oC", title: "子", parent_node_token: "P" });
      const client = new FakeClient([P, C], { oP: textBlocks("父正文"), oC: textBlocks("子正文") });
      const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
      const now = () => new Date("2026-09-03T00:00:00.000Z");

      await runExportOnce(cfg, { client, logger: quietLogger(root), now });
      const parentDir = path.join(dir, "父");
      const oldAbs = path.join(parentDir, "子.md");
      expect(fs.existsSync(oldAbs)).toBe(true);

      // 子节点挪到根目录，且内容也同时变化（同时触发 toMove 与 toExport）
      client.nodes = [P, { ...C, parent_node_token: "", obj_edit_time: "200" }];
      client.blocksByObjToken["oC"] = textBlocks("子正文-改");

      // 去掉源目录的写权限：unlink/rename 源目录里的条目都需要目录本身的写权限，
      // 只读+可执行（0o555）足以让 git mv 与 fs.rename 双双失败，且跨平台（非 Windows）通用。
      fs.chmodSync(parentDir, 0o555);
      try {
        const r2 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
        expect(r2.error).toBeUndefined(); // 单节点移动失败不是致命错误
        expect(r2.moved).toBe(0);
        expect(r2.exported).toBe(0); // 修复点：跳过导出，不产生孤儿
        expect(fs.existsSync(oldAbs)).toBe(true); // 旧文件还在
        expect(fs.existsSync(path.join(dir, "子.md"))).toBe(false); // 新文件没被创建

        const manifest = readExporterManifest(dir)!;
        expect(manifest.nodes["C"].path).toBe("父/子.md"); // manifest 未被错误更新
      } finally {
        fs.chmodSync(parentDir, 0o755); // 恢复，避免污染 tmp 清理
      }

      // 恢复后下一轮应顺利补上移动+重导
      const r3 = await runExportOnce(cfg, { client, logger: quietLogger(root), now });
      expect(r3.error).toBeUndefined();
      expect(r3.moved).toBe(1);
      expect(r3.exported).toBe(1);
      expect(fs.existsSync(oldAbs)).toBe(false);
      expect(fs.existsSync(path.join(dir, "子.md"))).toBe(true);
    }
  );
});

describe("--inbox-url 对已有 manifest 生效（finding#4）", () => {
  it("首轮无 inbox → 第二轮带 inboxUrl → manifest 更新且该轮至少心跳提交", async () => {
    const root = tmpDir("exp-inbox-update");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const A = node({ node_token: "A", obj_token: "oA", title: "甲" });
    const client = new FakeClient([A], { oA: textBlocks("甲正文") });
    const now = ticker();

    const cfg1: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const r1 = await runExportOnce(cfg1, { client, logger: quietLogger(root), now });
    expect(r1.error).toBeUndefined();
    expect(readExporterManifest(dir)!.agent_inbox_url).toBeUndefined();

    const cfg2: ExporterConfig = { ...cfg1, inboxUrl: "https://acme.feishu.cn/wiki/AgentInbox1" };
    const r2 = await runExportOnce(cfg2, { client, logger: quietLogger(root), now });
    expect(r2.error).toBeUndefined();
    expect(r2.committed).toBe(true); // manifest 变化 → hasChanges 为真 → 至少心跳提交
    expect(readExporterManifest(dir)!.agent_inbox_url).toBe("https://acme.feishu.cn/wiki/AgentInbox1");
  });
});

describe("mention_doc.token 命名空间兜底（finding#5：obj_token 而非 node_token）", () => {
  it("mention_doc.token 用目标节点的 obj_token → 仍命中相对路径双链", async () => {
    const root = tmpDir("exp-mention-objtoken");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const A = node({ node_token: "A", obj_token: "oA", title: "甲" });
    const B = node({ node_token: "B", obj_token: "oB", title: "乙" });
    const mentionBlocks: DocxBlock[] = [
      { block_id: "page", block_type: 1, children: ["t1"] },
      {
        block_id: "t1",
        block_type: 2,
        parent_id: "page",
        text: { elements: [{ mention_doc: { token: "oB", title: "乙" } }] },
      },
    ];
    const client = new FakeClient([A, B], { oA: mentionBlocks, oB: textBlocks("乙正文") });
    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const result = await runExportOnce(cfg, { client, logger: quietLogger(root) });

    expect(result.error).toBeUndefined();
    const content = read(dir, "甲.md");
    expect(content).toContain("[乙](乙.md)（[飞书](https://acme.feishu.cn/wiki/B)）");
  });
});

describe("tryMoveNode（纯逻辑：Important#2 移动失败判定）", () => {
  it("git mv 成功：直接返回 true，不调用 rename 降级", () => {
    const calls: string[] = [];
    const ok = tryMoveNode("a.md", "b.md", quietLogger(tmpDir("exp7-trymove1")), {
      gitMv: () => {
        calls.push("gitMv");
        return true;
      },
      rename: () => {
        calls.push("rename");
      },
    });
    expect(ok).toBe(true);
    expect(calls).toEqual(["gitMv"]);
  });

  it("git mv 失败、rename 成功：降级成功返回 true", () => {
    const ok = tryMoveNode("a.md", "b.md", quietLogger(tmpDir("exp7-trymove2")), {
      gitMv: () => false,
      rename: () => {},
    });
    expect(ok).toBe(true);
  });

  it("git mv 与 rename 均失败：返回 false（调用方据此把该 token 计入 skip 集合）", () => {
    const dir = tmpDir("exp7-trymove3");
    const ok = tryMoveNode("a.md", "b.md", quietLogger(dir), {
      gitMv: () => false,
      rename: () => {
        throw new Error("模拟 rename 失败");
      },
    });
    expect(ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, "test.log"), "utf8")).toContain("移动失败");
  });
});
