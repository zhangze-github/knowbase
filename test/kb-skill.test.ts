import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildCatalog,
  buildSkillMd,
  CATALOG_SPLIT_BYTES,
  kbSkillStatus,
  syncKbSkill,
  uninstallKbSkill,
} from "../src/kb-skill.js";
import { KB_SKILL_NAME } from "../src/agent-config.js";
import { syncSkills, MARKER_NAME } from "../src/skills-sync.js";
import { tmpDir } from "./helpers.js";

let home: string;
let kb: string;

beforeEach(() => {
  home = tmpDir("kbskill-home");
  kb = tmpDir("kbskill-kb");
  fs.mkdirSync(path.join(kb, "项目", "子项目"), { recursive: true });
  fs.writeFileSync(path.join(kb, "项目", "子项目", "方案.md"), "x");
  fs.writeFileSync(path.join(kb, "项目", "概览.md"), "x");
  fs.writeFileSync(path.join(kb, "使用指南.md"), "x");
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(kb, { recursive: true, force: true });
});

const claudeSkill = () => path.join(home, ".claude", "skills", KB_SKILL_NAME);

describe("SKILL.md 文案", () => {
  it("frontmatter：name 固定、description 是合法的双引号标量并写明知识库位置", () => {
    const md = buildSkillMd("/kb: odd", 3);
    const lines = md.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe(`name: ${KB_SKILL_NAME}`);
    expect(lines[2].startsWith('description: "')).toBe(true);
    expect(JSON.parse(lines[2].slice("description: ".length))).toContain("/kb: odd");
  });

  it("写入流程：只读声明 + feishu_url 引导 + 平权自主归属，无专属 AI 目录", () => {
    const md = buildSkillMd("/kb", 3);
    expect(md).toContain("只读本地镜像");
    expect(md).toContain("feishu_url");
    expect(md).toContain("lark-doc");
    expect(md).toContain("平权");
    expect(md).toContain("自行判断");
    expect(md).not.toContain("Agent 沉淀");
    expect(md).not.toContain("保存即同步");
  });

  it("沉淀标准：组织/个人内容边界写明", () => {
    const md = buildSkillMd("/kb", 3);
    expect(md).toContain("复用价值");
    expect(md).toContain("个人偏好");
    expect(md).toContain("不进知识库");
    expect(md).toContain("询问用户");
  });

  it("查找方法：指向完整目录，并要求说「没有」之前多轮搜索", () => {
    const md = buildSkillMd("/kb", 3);
    expect(md).toContain("references/catalog.md");
    expect(md).toContain("知识库里没有");
    expect(md).toContain("rg");
  });

  it("飞书应用身份：默认不出现，开启后位于写入流程内", () => {
    expect(buildSkillMd("/kb", 3)).not.toContain("--as bot");
    const md = buildSkillMd("/kb", 3, true);
    const write = md.slice(md.indexOf("## 写入"), md.indexOf("## 沉淀标准"));
    expect(write).toContain("--profile knowbase-writer --as bot");
  });
});

describe("完整目录", () => {
  it("列出全部文件，不折叠，排除仓库根 skills", () => {
    fs.mkdirSync(path.join(kb, "skills", "deploy"), { recursive: true });
    fs.writeFileSync(path.join(kb, "skills", "deploy", "SKILL.md"), "x");
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(kb, "项目", `doc-${i}.md`), "x");
    const files = buildCatalog(kb);
    expect(Object.keys(files)).toEqual(["references/catalog.md"]);
    const cat = files["references/catalog.md"];
    expect(cat).toContain("共 33 篇");
    expect(cat).toContain("    方案.md");
    for (let i = 0; i < 30; i++) expect(cat).toContain(`doc-${i}.md`);
    expect(cat).not.toContain("未列出");
    expect(cat).not.toContain("SKILL.md");
  });

  it("超过拆分阈值 → 按顶层目录拆成多个文件，索引指向分片", () => {
    const long = "很长的文档标题".repeat(8);
    for (let d = 0; d < 3; d++) {
      fs.mkdirSync(path.join(kb, `领域${d}`));
      for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(kb, `领域${d}`, `${long}-${i}.md`), "x");
    }
    const files = buildCatalog(kb);
    const names = Object.keys(files).sort();
    expect(names.length).toBeGreaterThan(2);
    const index = files["references/catalog.md"];
    expect(index).toContain("领域0/");
    expect(index).toContain("catalog-01.md");
    expect(index).toContain("使用指南.md");
    for (const n of names) {
      if (n === "references/catalog.md") continue;
      expect(Buffer.byteLength(files[n], "utf8")).toBeLessThan(CATALOG_SPLIT_BYTES * 2);
    }
    const all = Object.values(files).join("\n");
    expect(all).toContain(`${long}-399.md`);
  });
});

describe("syncKbSkill / uninstallKbSkill", () => {
  it("写入 Claude Code skills 目录：SKILL.md、完整目录与托管标记", () => {
    const changes = syncKbSkill(kb, home);
    expect(changes).toEqual([{ tool: "Claude Code", dir: claudeSkill(), action: "created" }]);
    expect(fs.readFileSync(path.join(claudeSkill(), "SKILL.md"), "utf8")).toContain(`name: ${KB_SKILL_NAME}`);
    expect(fs.readFileSync(path.join(claudeSkill(), "references", "catalog.md"), "utf8")).toContain("方案.md");
    expect(fs.existsSync(path.join(claudeSkill(), MARKER_NAME))).toBe(true);
    expect(fs.readdirSync(path.dirname(claudeSkill())).some((n) => n.includes("knowbase-tmp"))).toBe(false);
  });

  it("内容未变 → unchanged；知识库变化或本机手改 → updated 并恢复", () => {
    syncKbSkill(kb, home);
    expect(syncKbSkill(kb, home)[0].action).toBe("unchanged");

    fs.writeFileSync(path.join(kb, "新增.md"), "x");
    expect(syncKbSkill(kb, home)[0].action).toBe("updated");
    expect(fs.readFileSync(path.join(claudeSkill(), "references", "catalog.md"), "utf8")).toContain("新增.md");

    fs.writeFileSync(path.join(claudeSkill(), "SKILL.md"), "被手改了");
    expect(syncKbSkill(kb, home)[0].action).toBe("updated");
    expect(fs.readFileSync(path.join(claudeSkill(), "SKILL.md"), "utf8")).toContain(`name: ${KB_SKILL_NAME}`);
  });

  it("同名目录不是 knowbase 建的 → foreign，不覆盖；uninstall 也不碰", () => {
    fs.mkdirSync(claudeSkill(), { recursive: true });
    fs.writeFileSync(path.join(claudeSkill(), "SKILL.md"), "我的个人 skill");
    expect(syncKbSkill(kb, home)[0].action).toBe("foreign");
    expect(uninstallKbSkill(home)).toEqual([]);
    expect(fs.readFileSync(path.join(claudeSkill(), "SKILL.md"), "utf8")).toBe("我的个人 skill");
    expect(kbSkillStatus(home)[0]).toMatchObject({ installed: false, foreign: true });
  });

  it("装了 Codex 时同样写入 ~/.codex/skills", () => {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
    const tools = syncKbSkill(kb, home).map((c) => c.tool);
    expect(tools).toEqual(["Claude Code", "Codex"]);
    expect(fs.existsSync(path.join(home, ".codex", "skills", KB_SKILL_NAME, "SKILL.md"))).toBe(true);
  });

  it("团队 skills 同步不会把内置 skill 当孤儿删掉", () => {
    fs.mkdirSync(path.join(kb, "skills", "deploy"), { recursive: true });
    fs.writeFileSync(path.join(kb, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: d\n---\n");
    syncKbSkill(kb, home);
    syncSkills(kb, home);
    expect(fs.existsSync(path.join(claudeSkill(), "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "org-deploy", "SKILL.md"))).toBe(true);
  });

  it("uninstall 移除带标记的内置 skill", () => {
    syncKbSkill(kb, home);
    expect(kbSkillStatus(home)[0].installed).toBe(true);
    const r = uninstallKbSkill(home);
    expect(r).toEqual([{ tool: "Claude Code", dir: claudeSkill(), removed: true }]);
    expect(fs.existsSync(claudeSkill())).toBe(false);
  });
});

describe("客户端目录下没有 skills/ 时自动创建", () => {
  const team = () => {
    fs.mkdirSync(path.join(kb, "skills", "deploy"), { recursive: true });
    fs.writeFileSync(path.join(kb, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: d\n---\n");
  };

  it("Claude Code 与 Codex 都没有 skills/ → 首次同步建出目录并装好全部 skill", () => {
    team();
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
    syncSkills(kb, home);
    syncKbSkill(kb, home);
    for (const client of [".claude", ".codex"]) {
      const dir = path.join(home, client, "skills");
      expect(fs.readdirSync(dir).sort()).toEqual([KB_SKILL_NAME, "org-deploy"]);
    }
  });

  it("Claude Code 本身还没装（连 ~/.claude 都没有）→ 照样建出 ~/.claude/skills", () => {
    team();
    syncSkills(kb, home);
    syncKbSkill(kb, home);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "org-deploy", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(claudeSkill(), "SKILL.md"))).toBe(true);
  });

  it("skills/ 整个被删掉 → 下一次同步重新建出来", () => {
    team();
    syncSkills(kb, home);
    syncKbSkill(kb, home);
    fs.rmSync(path.join(home, ".claude", "skills"), { recursive: true });
    expect(syncSkills(kb, home).find((c) => c.tool === "Claude Code")?.action).toBe("created");
    expect(syncKbSkill(kb, home)[0].action).toBe("created");
    expect(fs.readdirSync(path.join(home, ".claude", "skills")).sort()).toEqual([KB_SKILL_NAME, "org-deploy"]);
  });
});
