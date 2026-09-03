import { describe, it, expect } from "vitest";
import { renderDocxToMarkdown } from "../src/exporter/docx-md.js";
import type { DocxBlock } from "../src/exporter/lark-client.js";

const CTX = { selfUrl: "https://acme.feishu.cn/wiki/N1" };
const run = (content: string, style: object = {}) => ({ text_run: { content, text_element_style: style } });
function doc(...body: DocxBlock[]): DocxBlock[] {
  return [
    { block_id: "root", block_type: 1, children: body.map((b) => b.block_id) },
    ...body,
  ];
}

describe("基础块渲染", () => {
  it("heading + text + 样式叠加", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "h", block_type: 3, heading1: { elements: [run("标题")] } },
      { block_id: "t", block_type: 2, text: { elements: [
        run("普通"), run("粗", { bold: true }), run("码", { inline_code: true }),
        run("链", { link: { url: encodeURIComponent("https://x.cn/a") } }),
      ] } },
    ) as DocxBlock[], CTX);
    expect(md).toContain("# 标题");
    expect(md).toContain("**粗**");
    expect(md).toContain("`码`");
    expect(md).toContain("[链](https://x.cn/a)");
  });

  it("bullet 嵌套缩进 + ordered 连续编号与打断重计", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "b1", block_type: 12, bullet: { elements: [run("一级")] }, children: ["b2"] },
      { block_id: "o1", block_type: 13, ordered: { elements: [run("甲")] } },
      { block_id: "o2", block_type: 13, ordered: { elements: [run("乙")] } },
      { block_id: "t", block_type: 2, text: { elements: [run("打断")] } },
      { block_id: "o3", block_type: 13, ordered: { elements: [run("丙")] } },
    ).concat([{ block_id: "b2", block_type: 12, bullet: { elements: [run("二级")] } }]) as DocxBlock[], CTX);
    expect(md).toContain("- 一级\n  - 二级");
    expect(md).toContain("1. 甲\n2. 乙");
    expect(md).toMatch(/打断[\s\S]*1\. 丙/);
  });

  it("code / quote / todo / divider / heading 封顶", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "c", block_type: 14, code: { elements: [run("const a=1")], style: { language: 63 } } },
      { block_id: "q", block_type: 15, quote: { elements: [run("引用")] } },
      { block_id: "td", block_type: 17, todo: { elements: [run("待办")], style: { done: true } } },
      { block_id: "d", block_type: 22 },
      { block_id: "h9", block_type: 11, heading9: { elements: [run("深")] } },
    ) as DocxBlock[], CTX);
    expect(md).toContain("```typescript\nconst a=1\n```");
    expect(md).toContain("> 引用");
    expect(md).toContain("- [x] 待办");
    expect(md).toContain("---");
    expect(md).toContain("###### 深"); // 9 级封顶 6
  });

  it("equation 与 mention_user", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "t", block_type: 2, text: { elements: [
        { equation: { content: "E=mc^2" } },
        { mention_user: { user_id: "ou_1" } },
      ] } },
    ) as DocxBlock[], CTX);
    expect(md).toContain("$E=mc^2$");
    expect(md).toContain("@ou_1");
  });

  it("不可见空块不打断 ordered 编号，也不产出纯空白行", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "o1", block_type: 13, ordered: { elements: [run("A")] } },
      { block_id: "empty", block_type: 2, text: { elements: [] } },
      { block_id: "o2", block_type: 13, ordered: { elements: [run("B")] } },
      { block_id: "b1", block_type: 12, bullet: { elements: [run("项")] }, children: ["e1"] },
    ).concat([
      { block_id: "e1", block_type: 2, text: { elements: [] } },
    ]) as DocxBlock[], CTX);
    expect(md).toContain("1. A");
    expect(md).toContain("2. B");
    // 空段落被空块打断编号的旧 bug 会在此处产出两个 "1."
    expect(md).not.toMatch(/1\. A[\s\S]*1\. B/);
    // 嵌套空块（depth>0）不应产出只含缩进空格的空白行
    expect(md.split("\n").some((l) => l.length > 0 && l.trim() === "")).toBe(false);
  });
});

describe("复杂块与降级", () => {
  it("2x2 表格：表头 + 分隔行 + 数据行；单元格内 | 转义、换行压成空格", () => {
    const md = renderDocxToMarkdown(doc(
      {
        block_id: "tb",
        block_type: 31,
        table: {
          property: { row_size: 2, column_size: 2 },
          cells: ["c1", "c2", "c3", "c4"],
        },
      },
      { block_id: "c1", block_type: 32, children: ["c1t"] },
      { block_id: "c1t", block_type: 2, text: { elements: [run("表头一")] } },
      { block_id: "c2", block_type: 32, children: ["c2t"] },
      { block_id: "c2t", block_type: 2, text: { elements: [run("表头二")] } },
      { block_id: "c3", block_type: 32, children: ["c3t"] },
      { block_id: "c3t", block_type: 2, text: { elements: [run("a|b")] } },
      { block_id: "c4", block_type: 32, children: ["c4a", "c4b"] },
      { block_id: "c4a", block_type: 2, text: { elements: [run("行一")] } },
      { block_id: "c4b", block_type: 2, text: { elements: [run("行二")] } },
    ) as DocxBlock[], CTX);
    const lines = md.split("\n");
    expect(lines[0]).toBe("| 表头一 | 表头二 |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toContain("a\\|b");
    expect(lines[2]).toContain("行一 行二");
  });

  it("callout：children 两个 text 块每行都有 > 前缀", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "co", block_type: 19, children: ["t1", "t2"] },
      { block_id: "t1", block_type: 2, text: { elements: [run("行一")] } },
      { block_id: "t2", block_type: 2, text: { elements: [run("行二")] } },
    ) as DocxBlock[], CTX);
    expect(md).toContain("> 行一");
    expect(md).toContain("> 行二");
  });

  it("image → 占位含 selfUrl", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "img", block_type: 27, image: {} },
    ) as DocxBlock[], CTX);
    expect(md).toContain("🖼 图片见原文");
    expect(md).toContain(`[${CTX.selfUrl}](${CTX.selfUrl})`);
  });

  it("bitable 与未知类型 999 → 无法转换占位", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "bt", block_type: 18 },
      { block_id: "unk", block_type: 999 },
    ) as DocxBlock[], CTX);
    expect(md).toContain("⚠ 此处为无法转换的内容（type 18）");
    expect(md).toContain("⚠ 此处为无法转换的内容（type 999）");
    expect(md).toContain(`[原文](${CTX.selfUrl})`);
  });

  it("mention_doc 命中 pathForToken → 相对路径双链", () => {
    const ctx = {
      selfUrl: "https://acme.feishu.cn/wiki/N1",
      selfPath: "a/b.md",
      pathForToken: (_t: string) => "c/d.md",
      urlForToken: (_t: string) => "https://x/wiki/T",
    };
    const md = renderDocxToMarkdown(doc(
      { block_id: "t", block_type: 2, text: { elements: [
        { mention_doc: { token: "tok1", title: "标题" } },
      ] } },
    ) as DocxBlock[], ctx);
    expect(md).toContain("[标题](../c/d.md)（[飞书](https://x/wiki/T)）");
  });

  it("mention_doc 未命中 → 直接用 mention_doc.url", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "t", block_type: 2, text: { elements: [
        { mention_doc: { token: "tok2", title: "标题", url: "https://acme.feishu.cn/wiki/T2" } },
      ] } },
    ) as DocxBlock[], CTX);
    expect(md).toContain("[标题](https://acme.feishu.cn/wiki/T2)");
  });
});
