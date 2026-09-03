import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpDir, g, makeEmptyOrigin, cloneWorkdir, read } from "./helpers.js";
import { Logger } from "../src/config.js";
import { readExporterManifest } from "../src/exporter/manifest.js";
import type { WikiNode } from "../src/exporter/tree-diff.js";
import type { DocxBlock } from "../src/exporter/lark-client.js";
import { runExportOnce, ExporterConfig, LarkClientLike } from "../src/exporter/exporter.js";

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

/** 内存版 LarkClientLike：nodes 固定、blocksByObjToken 可变，failTokens 模拟单篇拉取失败。 */
class FakeClient implements LarkClientLike {
  failTokens = new Set<string>();
  constructor(
    public nodes: WikiNode[],
    public blocksByObjToken: Record<string, DocxBlock[]>
  ) {}
  async listAllSpaceNodes(): Promise<WikiNode[]> {
    return this.nodes;
  }
  async listDocBlocks(documentId: string): Promise<DocxBlock[]> {
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
