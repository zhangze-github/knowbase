import { describe, it, expect } from "vitest";
import {
  WikiNode, planPaths, diffTree, sanitizeTitle,
} from "../src/exporter/tree-diff.js";

function n(p: Partial<WikiNode>): WikiNode {
  return {
    node_token: "t" + Math.random().toString(36).slice(2, 8),
    obj_token: "o1", obj_type: "docx", parent_node_token: "",
    title: "未命名", obj_edit_time: "100", has_child: false,
    ...p,
  };
}

describe("sanitizeTitle", () => {
  it("清洗非法字符、折叠、空标题回退", () => {
    expect(sanitizeTitle("a/b:c*?")).toBe("a-b-c-");
    expect(sanitizeTitle("  x  ")).toBe("x");
    expect(sanitizeTitle('a<">b')).toBe("a-b");
    expect(sanitizeTitle("///")).toBe("");
  });
});

describe("planPaths", () => {
  it("叶子 → title.md；有子 → title/title.md；层级正确", () => {
    const parent = n({ node_token: "P", title: "指南", has_child: true });
    const child = n({ node_token: "C", title: "部署", parent_node_token: "P" });
    const top = n({ node_token: "T", title: "FAQ" });
    const m = planPaths([parent, child, top]);
    expect(m.get("P")!.path).toBe("指南/指南.md");
    expect(m.get("C")!.path).toBe("指南/部署.md");
    expect(m.get("T")!.path).toBe("FAQ.md");
  });

  it("同父重名 → 追加 node_token 前 6 位", () => {
    const a = n({ node_token: "AAAAAAAA", title: "同名" });
    const b = n({ node_token: "BBBBBBBB", title: "同名" });
    const m = planPaths([a, b]);
    expect(m.get("AAAAAAAA")!.path).toBe("同名.md");
    expect(m.get("BBBBBBBB")!.path).toBe("同名-BBBBBB.md");
  });

  it("rootToken 限定子树，路径以子树为根", () => {
    const root = n({ node_token: "R", title: "根", has_child: true });
    const kid = n({ node_token: "K", title: "孩子", parent_node_token: "R" });
    const other = n({ node_token: "X", title: "库外" });
    const m = planPaths([root, kid, other], "R");
    expect(m.has("R")).toBe(false);
    expect(m.has("X")).toBe(false);
    expect(m.get("K")!.path).toBe("孩子.md");
  });

  it("纯符号标题清洗为空，token 前 8 位兜底", () => {
    const node = n({ node_token: "TOKEN12345", title: "///" });
    const m = planPaths([node]);
    expect(m.get("TOKEN12345")!.path).toBe("TOKEN123.md");
  });
});

describe("diffTree", () => {
  it("新增/变更/移动/删除分类正确，移动且变更同时出现在两个集合", () => {
    const a = n({ node_token: "A", title: "甲", obj_edit_time: "200" }); // 变更
    const b = n({ node_token: "B", title: "乙新名", obj_edit_time: "100" }); // 仅改名
    const c = n({ node_token: "C", title: "丙", obj_edit_time: "300" });  // 新增
    const d = n({ node_token: "D", title: "丁", obj_edit_time: "500" });  // 改名+变更
    const planned = planPaths([a, b, c, d]);
    const prev = {
      A: { path: "甲.md", obj_edit_time: "100", hash: "h" },
      B: { path: "乙.md", obj_edit_time: "100", hash: "h" },
      D: { path: "旧丁.md", obj_edit_time: "400", hash: "h" },
      GONE: { path: "没了.md", obj_edit_time: "1", hash: "h" },
    };
    const diff = diffTree(planned, prev);
    expect(diff.toExport.map((p) => p.node.node_token).sort()).toEqual(["A", "C", "D"]);
    expect(diff.toMove.map((m) => m.from).sort()).toEqual(["乙.md", "旧丁.md"]);
    expect(diff.toRemove).toEqual([{ node_token: "GONE", path: "没了.md" }]);
  });

  it("无任何变化 → 三个集合皆空", () => {
    const a = n({ node_token: "A", title: "甲", obj_edit_time: "100" });
    const planned = planPaths([a]);
    const prev = { A: { path: "甲.md", obj_edit_time: "100", hash: "h" } };
    const d = diffTree(planned, prev);
    expect(d.toExport).toEqual([]);
    expect(d.toMove).toEqual([]);
    expect(d.toRemove).toEqual([]);
  });
});
