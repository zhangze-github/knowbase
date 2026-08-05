import { describe, it, expect } from "vitest";
import { ORG_PREFIX, prefixedName, rewriteSkillName } from "../src/skills-sync.js";

describe("prefixedName", () => {
  it("正常名字加前缀", () => {
    expect(prefixedName("code-review")).toBe("org-code-review");
    expect(prefixedName("a")).toBe("org-a");
    expect(prefixedName("deploy_v2.1")).toBe("org-deploy_v2.1");
  });

  it("已带前缀不重复加", () => {
    expect(prefixedName("org-foo")).toBe("org-foo");
  });

  it("非法名字返回 null", () => {
    // 这些名字会被直接拼进 ~/.claude/skills/ 的路径，必须挡住
    expect(prefixedName("..")).toBeNull();
    expect(prefixedName("../evil")).toBeNull();
    expect(prefixedName("a/b")).toBeNull();
    expect(prefixedName(".hidden")).toBeNull();
    expect(prefixedName("")).toBeNull();
    expect(prefixedName("有中文")).toBeNull();
    expect(prefixedName("-lead-dash")).toBeNull();
  });

  it("ORG_PREFIX 常量对外可见", () => {
    expect(ORG_PREFIX).toBe("org-");
  });
});

describe("rewriteSkillName", () => {
  it("改写 frontmatter 里的 name 字段", () => {
    const md = "---\nname: code-review\ndescription: 审查代码\n---\n\n# 正文\n";
    expect(rewriteSkillName(md, "org-code-review")).toBe(
      "---\nname: org-code-review\ndescription: 审查代码\n---\n\n# 正文\n"
    );
  });

  it("只改 frontmatter 块内第一个 name，正文里的 name: 不动", () => {
    const md = "---\nname: a\n---\n\n返回字段 name: xxx\n";
    const out = rewriteSkillName(md, "org-a")!;
    expect(out).toContain("name: org-a\n");
    expect(out).toContain("返回字段 name: xxx");
  });

  it("frontmatter 里有多个 name 时只改第一个", () => {
    const md = "---\nname: a\nother: 1\nname: b\n---\n";
    expect(rewriteSkillName(md, "org-a")).toBe(
      "---\nname: org-a\nother: 1\nname: b\n---\n"
    );
  });

  it("保留 CRLF 行尾，不产出混合行尾", () => {
    const md = "---\r\nname: a\r\ndescription: d\r\n---\r\n";
    expect(rewriteSkillName(md, "org-a")).toBe(
      "---\r\nname: org-a\r\ndescription: d\r\n---\r\n"
    );
  });

  it("无 frontmatter 返回 null", () => {
    expect(rewriteSkillName("# 只有正文\n", "org-a")).toBeNull();
  });

  it("frontmatter 未闭合返回 null", () => {
    expect(rewriteSkillName("---\nname: a\n", "org-a")).toBeNull();
  });

  it("frontmatter 里无 name 字段返回 null", () => {
    expect(rewriteSkillName("---\ndescription: d\n---\n", "org-a")).toBeNull();
  });
});
