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
