import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpDir, makeEmptyOrigin, cloneWorkdir } from "./helpers.js";
import { Logger } from "../src/config.js";
import { parseExporterArgs } from "../src/commands/exporter.js";
import { runExporterDaemon, ExporterConfig, LarkClientLike } from "../src/exporter/exporter.js";
import type { WikiNode } from "../src/exporter/tree-diff.js";
import type { DocxBlock } from "../src/exporter/lark-client.js";

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

/**
 * 最小复制自 test/exporter-run.test.ts 的 FakeClient（该文件未导出它），
 * 本文件只需要跑通 runExporterDaemon 的 maxCycles 循环，不需要 failTokens/calls 记录。
 */
class FakeClient implements LarkClientLike {
  constructor(
    public nodes: WikiNode[],
    public blocksByObjToken: Record<string, DocxBlock[]>
  ) {}
  async listAllSpaceNodes(): Promise<WikiNode[]> {
    return this.nodes;
  }
  async listDocBlocks(documentId: string): Promise<DocxBlock[]> {
    return this.blocksByObjToken[documentId] ?? [];
  }
}

function textBlocks(content: string): DocxBlock[] {
  return [
    { block_id: "page", block_type: 1, children: ["t1"] },
    { block_id: "t1", block_type: 2, parent_id: "page", text: { elements: [{ text_run: { content } }] } },
  ];
}

describe("parseExporterArgs", () => {
  const fullEnv = {
    KNOWBASE_LARK_APP_ID: "id1",
    KNOWBASE_LARK_APP_SECRET: "secret1",
  } as NodeJS.ProcessEnv;

  it("纯 space_id + --host：解析出 host/spaceId，无 nodeToken", () => {
    const r = parseExporterArgs({ repo: "/tmp/repo", space: "7123456", host: "acme.feishu.cn" }, fullEnv);
    expect(r.errors).toEqual([]);
    expect(r.host).toBe("acme.feishu.cn");
    expect(r.spaceId).toBe("7123456");
    expect(r.nodeToken).toBeUndefined();
  });

  it("space 首页 URL：解析出 host + spaceId", () => {
    const r = parseExporterArgs(
      { repo: "/tmp/repo", space: "https://acme.feishu.cn/wiki/space/7123456" },
      fullEnv
    );
    expect(r.errors).toEqual([]);
    expect(r.host).toBe("acme.feishu.cn");
    expect(r.spaceId).toBe("7123456");
    expect(r.nodeToken).toBeUndefined();
  });

  it("节点 URL：解析出 host + nodeToken，spaceId 留空待运行期补齐", () => {
    const r = parseExporterArgs(
      { repo: "/tmp/repo", space: "https://acme.feishu.cn/wiki/N7abcdxyz" },
      fullEnv
    );
    expect(r.errors).toEqual([]);
    expect(r.host).toBe("acme.feishu.cn");
    expect(r.nodeToken).toBe("N7abcdxyz");
    expect(r.spaceId).toBeUndefined();
  });

  it("缺 env 凭据 → errors 含 KNOWBASE_LARK_APP_ID / KNOWBASE_LARK_APP_SECRET 字样", () => {
    const r = parseExporterArgs(
      { repo: "/tmp/repo", space: "7123456", host: "acme.feishu.cn" },
      {} as NodeJS.ProcessEnv
    );
    expect(r.errors.some((e) => e.includes("KNOWBASE_LARK_APP_ID"))).toBe(true);
    expect(r.errors.some((e) => e.includes("KNOWBASE_LARK_APP_SECRET"))).toBe(true);
  });

  it("纯 space_id 缺 --host → errors 非空", () => {
    const r = parseExporterArgs({ repo: "/tmp/repo", space: "7123456" }, fullEnv);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some((e) => e.includes("--host"))).toBe(true);
  });

  it("interval 非法值回落默认 120；合法值透传", () => {
    expect(
      parseExporterArgs({ repo: "/tmp/repo", space: "7123456", host: "h", interval: "abc" }, fullEnv).interval
    ).toBe(120);
    expect(
      parseExporterArgs({ repo: "/tmp/repo", space: "7123456", host: "h", interval: "-5" }, fullEnv).interval
    ).toBe(120);
    expect(
      parseExporterArgs({ repo: "/tmp/repo", space: "7123456", host: "h" }, fullEnv).interval
    ).toBe(120);
    expect(
      parseExporterArgs({ repo: "/tmp/repo", space: "7123456", host: "h", interval: "30" }, fullEnv).interval
    ).toBe(30);
  });

  it("--once/--full 透传", () => {
    const r = parseExporterArgs(
      { repo: "/tmp/repo", space: "7123456", host: "h", once: true, full: true },
      fullEnv
    );
    expect(r.once).toBe(true);
    expect(r.full).toBe(true);
  });

  it("缺 --repo → errors 非空", () => {
    const r = parseExporterArgs({ space: "7123456", host: "h" }, fullEnv);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("runExporterDaemon", () => {
  it("maxCycles=2：跑两轮，logger 记两行周期摘要", async () => {
    const root = tmpDir("exp-daemon");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);

    const A = node({ node_token: "A", obj_token: "oA", title: "甲" });
    const client = new FakeClient([A], { oA: textBlocks("甲正文") });

    const cfg: ExporterConfig = { repoDir: dir, branch: "main", spaceId: "spc1", host: "acme.feishu.cn" };
    const logger = new Logger(path.join(root, "exporter.log"));

    await runExporterDaemon(
      cfg,
      { client, logger },
      { intervalSec: 1, sleep: async () => {}, maxCycles: 2 }
    );

    const lines = logger.tail(20).filter((l) => l.includes("周期完成"));
    expect(lines.length).toBe(2);
  });
});
