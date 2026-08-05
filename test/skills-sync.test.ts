import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpDir, write } from "./helpers.js";
import {
  ORG_PREFIX,
  TMP_SUFFIX,
  MARKER_NAME,
  prefixedName,
  rewriteSkillName,
  listSkillFiles,
  hashSkillDir,
  readSkillSources,
  dedupeByTargetCase,
  planSkills,
  syncSkills,
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

  it("源名本身带 org- 前缀时，removed 的 name 必须来自标记而非从 target 反推", () => {
    // gone/org-gone 这对数据测不出问题：从 target 掐掉 org- 前缀反推 name，
    // 与正确实现直接读 marker.source，两者结果恰好都是 "gone"。
    // org-foo 的源名本身带前缀（prefixedName 不重复加前缀，name 和 target 都是
    // org-foo），反推会得到错误的 "foo"，与正确答案 "org-foo" 分叉，才测得出来。
    const p = planSkills([], [{ target: "org-foo", marker: mk("org-foo", "h1") }]);
    expect(p).toEqual([{ name: "org-foo", target: "org-foo", action: "removed" }]);
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

/** 假 home，返回 { home, skills } 两个路径。 */
function fakeHome(label: string): { home: string; skills: string } {
  const home = tmpDir(label);
  return { home, skills: path.join(home, ".claude", "skills") };
}

describe("syncSkills", () => {
  it("首次分发：目录落盘、name 改写、子目录带上、标记写入", () => {
    const kb = tmpDir("sync1-kb");
    const { home, skills } = fakeHome("sync1-home");
    seedSkill(kb, "code-review");
    write(kb, "skills/code-review/references/rules.md", "细则\n");

    const changes = syncSkills(kb, home);
    expect(changes.map((c) => c.action)).toEqual(["created"]);

    const dest = path.join(skills, "org-code-review");
    const md = fs.readFileSync(path.join(dest, "SKILL.md"), "utf8");
    expect(md).toContain("name: org-code-review");
    expect(md).not.toContain("name: code-review\n");
    expect(fs.readFileSync(path.join(dest, "references/rules.md"), "utf8")).toBe("细则\n");

    const marker = JSON.parse(fs.readFileSync(path.join(dest, MARKER_NAME), "utf8"));
    expect(marker.source).toBe("code-review");
    expect(marker.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof marker.syncedAt).toBe("string");
  });

  it("二次调用 unchanged 且不落盘", () => {
    const kb = tmpDir("sync2-kb");
    const { home, skills } = fakeHome("sync2-home");
    seedSkill(kb, "a");
    syncSkills(kb, home);

    const md = path.join(skills, "org-a", "SKILL.md");
    const before = fs.statSync(md).mtimeMs;
    const changes = syncSkills(kb, home);
    expect(changes.map((c) => c.action)).toEqual(["unchanged"]);
    expect(fs.statSync(md).mtimeMs).toBe(before);
  });

  it("源内容改动 → 重建；源里删文件 → 副本里也没了", () => {
    const kb = tmpDir("sync3-kb");
    const { home, skills } = fakeHome("sync3-home");
    seedSkill(kb, "a");
    write(kb, "skills/a/extra.md", "临时\n");
    syncSkills(kb, home);
    expect(fs.existsSync(path.join(skills, "org-a", "extra.md"))).toBe(true);

    fs.rmSync(path.join(kb, "skills/a/extra.md"));
    const changes = syncSkills(kb, home);
    expect(changes.map((c) => c.action)).toEqual(["updated"]);
    // 整体替换而非增量：幽灵文件必须消失
    expect(fs.existsSync(path.join(skills, "org-a", "extra.md"))).toBe(false);
  });

  it("源 skill 删除 → 托管副本被清理", () => {
    const kb = tmpDir("sync4-kb");
    const { home, skills } = fakeHome("sync4-home");
    seedSkill(kb, "a");
    syncSkills(kb, home);
    fs.rmSync(path.join(kb, "skills/a"), { recursive: true });

    const changes = syncSkills(kb, home);
    expect(changes.map((c) => c.action)).toEqual(["removed"]);
    expect(fs.existsSync(path.join(skills, "org-a"))).toBe(false);
  });

  it("目标同名但无标记 → foreign，内容不动", () => {
    const kb = tmpDir("sync5-kb");
    const { home, skills } = fakeHome("sync5-home");
    seedSkill(kb, "a");
    write(skills, "org-a/SKILL.md", "---\nname: org-a\n---\n我自己写的\n");

    const changes = syncSkills(kb, home);
    expect(changes[0].action).toBe("foreign");
    expect(fs.readFileSync(path.join(skills, "org-a", "SKILL.md"), "utf8")).toContain(
      "我自己写的"
    );
  });

  it("用户自己的非 org- skill 完全不受影响", () => {
    const kb = tmpDir("sync6-kb");
    const { home, skills } = fakeHome("sync6-home");
    seedSkill(kb, "a");
    write(skills, "my-own/SKILL.md", "---\nname: my-own\n---\n私人\n");

    syncSkills(kb, home);
    expect(fs.readFileSync(path.join(skills, "my-own", "SKILL.md"), "utf8")).toContain("私人");
  });

  it("残留的临时目录被清掉", () => {
    const kb = tmpDir("sync7-kb");
    const { home, skills } = fakeHome("sync7-home");
    seedSkill(kb, "a");
    write(skills, `org-a${TMP_SUFFIX}99999/SKILL.md`, "半成品\n");

    syncSkills(kb, home);
    const left = fs.readdirSync(skills).filter((n) => n.includes(TMP_SUFFIX));
    expect(left).toEqual([]);
  });

  it("保留可执行位", () => {
    const kb = tmpDir("sync8-kb");
    const { home, skills } = fakeHome("sync8-home");
    seedSkill(kb, "a");
    write(kb, "skills/a/run.sh", "#!/bin/sh\necho hi\n");
    fs.chmodSync(path.join(kb, "skills/a/run.sh"), 0o755);

    syncSkills(kb, home);
    const st = fs.statSync(path.join(skills, "org-a", "run.sh"));
    expect(st.mode & 0o111).not.toBe(0);
  });

  it("源里有软链 → 跳过该条目，其余文件正常拷贝，副本中无坏链", () => {
    const kb = tmpDir("sync9-kb");
    const { home, skills } = fakeHome("sync9-home");
    seedSkill(kb, "a");
    write(kb, "skills/a/real.md", "真的\n");
    fs.symlinkSync("/nowhere/gone", path.join(kb, "skills/a/dangling.md"));

    syncSkills(kb, home);
    const dest = path.join(skills, "org-a");
    expect(fs.readFileSync(path.join(dest, "real.md"), "utf8")).toBe("真的\n");
    expect(fs.existsSync(path.join(dest, "dangling.md"))).toBe(false);
  });

  it("skills/ 不存在 → 无动作、不抛错、不创建目标目录", () => {
    const kb = tmpDir("sync10-kb");
    const { home, skills } = fakeHome("sync10-home");
    expect(syncSkills(kb, home)).toEqual([]);
    expect(fs.existsSync(skills)).toBe(false);
  });

  it("invalid 源出现在返回的变更清单里", () => {
    const kb = tmpDir("sync11-kb");
    const { home } = fakeHome("sync11-home");
    seedSkill(kb, "good");
    write(kb, "skills/no-fm/SKILL.md", "# 正文\n");

    const changes = syncSkills(kb, home);
    const byName = Object.fromEntries(changes.map((c) => [c.name, c.action]));
    expect(byName).toEqual({ good: "created", "no-fm": "invalid" });
  });
});
