import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpDir, write } from "./helpers.js";
import {
  ORG_PREFIX,
  prefixedName,
  rewriteSkillName,
  listSkillFiles,
  hashSkillDir,
  readSkillSources,
  dedupeByTargetCase,
  planSkills,
} from "../src/skills-sync.js";
import type { SkillSource, SkillMarker } from "../src/skills-sync.js";

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
    // 正文这行必须以 name: 开头（而不是像「返回字段 name: xxx」那样 name: 不在行首），
    // 否则测不出扫描上界确实是 frontmatter 结束行——把循环上界从 end 误改成
    // lines.length 也会通过旧断言。
    const md = "---\nname: a\n---\n\nname: 不该被改\n";
    const out = rewriteSkillName(md, "org-a")!;
    expect(out).toBe("---\nname: org-a\n---\n\nname: 不该被改\n");
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

/** 在 kb/skills/<name>/ 下造一个合法 skill，返回 kb 根目录。 */
function seedSkill(kb: string, name: string, body = "步骤一\n"): void {
  write(kb, `skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: d\n---\n\n${body}`);
}

describe("listSkillFiles", () => {
  it("返回排序后的相对路径，跳过 .git 与软链", () => {
    const kb = tmpDir("skills-list");
    const dir = path.join(kb, "s");
    write(dir, "b.md", "b");
    write(dir, "a/c.md", "c");
    write(dir, ".git/HEAD", "ref");
    fs.symlinkSync("/etc/hosts", path.join(dir, "link.md"));

    const r = listSkillFiles(dir);
    expect(r.files).toEqual(["a/c.md", "b.md"]);
    expect(r.symlinks).toEqual(["link.md"]);
  });
});

describe("hashSkillDir", () => {
  it("内容变则哈希变", () => {
    const kb = tmpDir("skills-hash");
    const dir = path.join(kb, "s");
    write(dir, "a.md", "one");
    const h1 = hashSkillDir(dir);
    write(dir, "a.md", "two");
    expect(hashSkillDir(dir)).not.toBe(h1);
  });

  it("增删文件则哈希变", () => {
    const kb = tmpDir("skills-hash2");
    const dir = path.join(kb, "s");
    write(dir, "a.md", "one");
    const h1 = hashSkillDir(dir);
    write(dir, "b.md", "two");
    const h2 = hashSkillDir(dir);
    expect(h2).not.toBe(h1);
    fs.rmSync(path.join(dir, "b.md"));
    expect(hashSkillDir(dir)).toBe(h1);
  });

  it("文件重命名（内容集合不变）则哈希变", () => {
    // 路径必须进哈希，否则这种改动检测不到
    const kb = tmpDir("skills-hash3");
    const a = path.join(kb, "a");
    const b = path.join(kb, "b");
    write(a, "x.md", "same");
    write(b, "y.md", "same");
    expect(hashSkillDir(a)).not.toBe(hashSkillDir(b));
  });

  it("chmod +x 而内容不变时哈希也变", () => {
    // skill 可以带脚本，丢了 +x 就跑不起来，必须能触发重新分发
    const kb = tmpDir("skills-hash4");
    const dir = path.join(kb, "s");
    write(dir, "run.sh", "#!/bin/sh\n");
    const h1 = hashSkillDir(dir);
    fs.chmodSync(path.join(dir, "run.sh"), 0o755);
    expect(hashSkillDir(dir)).not.toBe(h1);
  });

  it("同内容不同目录哈希相同（与遍历顺序无关）", () => {
    const kb = tmpDir("skills-hash5");
    const a = path.join(kb, "a");
    const b = path.join(kb, "b");
    for (const d of [a, b]) {
      write(d, "z.md", "z");
      write(d, "m/n.md", "n");
      write(d, "a.md", "a");
    }
    expect(hashSkillDir(a)).toBe(hashSkillDir(b));
  });
});

describe("readSkillSources", () => {
  it("skills/ 不存在 → 空结果，不抛错", () => {
    const kb = tmpDir("skills-src0");
    const r = readSkillSources(kb);
    expect(r.sources).toEqual([]);
    expect(r.invalid).toEqual([]);
  });

  it("合法 skill → 带 target 与 hash", () => {
    const kb = tmpDir("skills-src1");
    seedSkill(kb, "code-review");
    const r = readSkillSources(kb);
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0].name).toBe("code-review");
    expect(r.sources[0].target).toBe("org-code-review");
    expect(r.sources[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.invalid).toEqual([]);
  });

  it("缺 SKILL.md / 缺 frontmatter / 缺 name → invalid，不影响其他 skill", () => {
    const kb = tmpDir("skills-src2");
    seedSkill(kb, "good");
    write(kb, "skills/no-skill-md/README.md", "素材");
    write(kb, "skills/no-fm/SKILL.md", "# 只有正文\n");
    write(kb, "skills/no-name/SKILL.md", "---\ndescription: d\n---\n");

    const r = readSkillSources(kb);
    expect(r.sources.map((s) => s.name)).toEqual(["good"]);
    expect(r.invalid.map((c) => c.name).sort()).toEqual([
      "no-fm",
      "no-name",
      "no-skill-md",
    ]);
    for (const c of r.invalid) {
      expect(c.action).toBe("invalid");
      expect(c.reason).toBeTruthy();
    }
  });

  it("目录名非法 → invalid", () => {
    const kb = tmpDir("skills-src3");
    seedSkill(kb, "good");
    write(kb, "skills/.hidden/SKILL.md", "---\nname: x\n---\n");
    const r = readSkillSources(kb);
    expect(r.sources.map((s) => s.name)).toEqual(["good"]);
    expect(r.invalid.map((c) => c.name)).toEqual([".hidden"]);
  });

});

describe("dedupeByTargetCase", () => {
  const s = (name: string): SkillSource => ({
    name,
    dir: `/kb/skills/${name}`,
    target: prefixedName(name)!,
    hash: "h",
  });

  it("仅大小写不同 → 取排序第一个，其余 dropped", () => {
    const r = dedupeByTargetCase([s("afoo"), s("Afoo")]);
    expect(r.kept.map((k) => k.name)).toEqual(["Afoo"]);
    expect(r.dropped).toEqual([{ name: "afoo", winner: "Afoo" }]);
  });

  it("结果与输入顺序无关", () => {
    expect(dedupeByTargetCase([s("Afoo"), s("afoo")]).kept.map((k) => k.name)).toEqual(["Afoo"]);
  });

  it("大小写不冲突时全部保留并按名字排序", () => {
    const r = dedupeByTargetCase([s("b"), s("a")]);
    expect(r.kept.map((k) => k.name)).toEqual(["a", "b"]);
    expect(r.dropped).toEqual([]);
  });

  it("三个变体 → 留一个丢两个", () => {
    const r = dedupeByTargetCase([s("Foo"), s("foo"), s("fOo")]);
    expect(r.kept.map((k) => k.name)).toEqual(["Foo"]);
    expect(r.dropped.map((d) => d.name).sort()).toEqual(["fOo", "foo"]);
  });
});

describe("planSkills", () => {
  const src = (name: string, hash: string): SkillSource => ({
    name,
    dir: `/kb/skills/${name}`,
    target: `org-${name}`,
    hash,
  });
  const mk = (source: string, hash: string): SkillMarker => ({
    source,
    hash,
    syncedAt: "2026-08-05T00:00:00.000Z",
  });

  it("目标不存在 → created", () => {
    const p = planSkills([src("a", "h1")], []);
    expect(p).toEqual([{ name: "a", target: "org-a", action: "created" }]);
  });

  it("有标记且哈希相同 → unchanged", () => {
    const p = planSkills([src("a", "h1")], [{ target: "org-a", marker: mk("a", "h1") }]);
    expect(p[0].action).toBe("unchanged");
  });

  it("有标记但哈希不同 → updated", () => {
    const p = planSkills([src("a", "h2")], [{ target: "org-a", marker: mk("a", "h1") }]);
    expect(p[0].action).toBe("updated");
  });

  it("目标存在但无标记 → foreign，带原因", () => {
    const p = planSkills([src("a", "h1")], [{ target: "org-a", marker: null }]);
    expect(p[0].action).toBe("foreign");
    expect(p[0].reason).toBeTruthy();
  });

  it("有标记但源已消失 → removed", () => {
    const p = planSkills([], [{ target: "org-gone", marker: mk("gone", "h1") }]);
    expect(p).toEqual([{ name: "gone", target: "org-gone", action: "removed" }]);
  });

  it("无标记且不在源列表中 → 完全不出现在计划里（用户自己的 skill）", () => {
    const p = planSkills([], [{ target: "org-mine", marker: null }]);
    expect(p).toEqual([]);
  });

  it("混合场景：各分支互不干扰", () => {
    const p = planSkills(
      [src("new", "h"), src("same", "h1"), src("moved", "h2"), src("theirs", "h")],
      [
        { target: "org-same", marker: mk("same", "h1") },
        { target: "org-moved", marker: mk("moved", "h1") },
        { target: "org-theirs", marker: null },
        { target: "org-orphan", marker: mk("orphan", "h") },
        { target: "my-own", marker: null },
      ]
    );
    const byName = Object.fromEntries(p.map((c) => [c.name, c.action]));
    expect(byName).toEqual({
      new: "created",
      same: "unchanged",
      moved: "updated",
      theirs: "foreign",
      orphan: "removed",
    });
  });
});
