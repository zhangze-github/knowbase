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
  uninstallSkills,
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

  it("名字含 TMP_SUFFIX 返回 null", () => {
    // NAME_RE 允许点号，"a.knowbase-tmp-9" 语法上合法，但落地后会被
    // readExistingTargets 当成临时目录永久忽略、被 cleanTmpDirs 每周期删除，
    // 造成周期性重拷/消失，必须在这一步挡住
    expect(prefixedName(`a${TMP_SUFFIX}9`)).toBeNull();
    expect(prefixedName(`org-a${TMP_SUFFIX}9`)).toBeNull();
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
  // copyHash 缺省不传：模拟老标记（本次改动前落盘的，没有这个字段）。
  const mk = (source: string, hash: string, copyHash?: string): SkillMarker => ({
    source,
    hash,
    ...(copyHash !== undefined ? { copyHash } : {}),
    syncedAt: "2026-08-05T00:00:00.000Z",
  });

  it("目标不存在 → created", () => {
    const p = planSkills([src("a", "h1")], []);
    expect(p).toEqual([{ name: "a", target: "org-a", action: "created" }]);
  });

  it("有标记且哈希相同、副本哈希也相同 → unchanged", () => {
    const p = planSkills(
      [src("a", "h1")],
      [{ target: "org-a", marker: mk("a", "h1", "c1"), copyHash: "c1" }]
    );
    expect(p[0].action).toBe("unchanged");
  });

  it("有标记但源哈希不同 → updated", () => {
    const p = planSkills(
      [src("a", "h2")],
      [{ target: "org-a", marker: mk("a", "h1", "c1"), copyHash: "c1" }]
    );
    expect(p[0].action).toBe("updated");
  });

  it("源哈希相同但副本被手改（copyHash 不匹配）→ updated（自愈重装）", () => {
    // 这是 I3 的核心场景：marker.hash 与源哈希对得上（源没变），但托管副本
    // 自身的内容哈希跟落盘时记录的不一致，说明本机手改过副本，必须重装。
    const p = planSkills(
      [src("a", "h1")],
      [{ target: "org-a", marker: mk("a", "h1", "c1"), copyHash: "c2" }]
    );
    expect(p[0].action).toBe("updated");
  });

  it("老标记没有 copyHash 字段 → 视为对不上，触发一次自愈重装而非误判 foreign", () => {
    // 升级前落盘的标记不带 copyHash，此时不该被当成「不是我们托管的」，
    // 而是自然落入 updated，重装一次后标记就补齐了这个字段。
    const p = planSkills(
      [src("a", "h1")],
      [{ target: "org-a", marker: mk("a", "h1"), copyHash: "c1" }]
    );
    expect(p[0].action).toBe("updated");
  });

  it("目标存在但无标记 → foreign，带原因", () => {
    const p = planSkills([src("a", "h1")], [{ target: "org-a", marker: null, copyHash: null }]);
    expect(p[0].action).toBe("foreign");
    expect(p[0].reason).toBeTruthy();
  });

  it("有标记但源已消失 → removed", () => {
    const p = planSkills(
      [],
      [{ target: "org-gone", marker: mk("gone", "h1", "c1"), copyHash: "c1" }]
    );
    expect(p).toEqual([{ name: "gone", target: "org-gone", action: "removed" }]);
  });

  it("源名本身带 org- 前缀时，removed 的 name 必须来自标记而非从 target 反推", () => {
    // gone/org-gone 这对数据测不出问题：从 target 掐掉 org- 前缀反推 name，
    // 与正确实现直接读 marker.source，两者结果恰好都是 "gone"。
    // org-foo 的源名本身带前缀（prefixedName 不重复加前缀，name 和 target 都是
    // org-foo），反推会得到错误的 "foo"，与正确答案 "org-foo" 分叉，才测得出来。
    const p = planSkills(
      [],
      [{ target: "org-foo", marker: mk("org-foo", "h1", "c1"), copyHash: "c1" }]
    );
    expect(p).toEqual([{ name: "org-foo", target: "org-foo", action: "removed" }]);
  });

  it("无标记且不在源列表中 → 完全不出现在计划里（用户自己的 skill）", () => {
    const p = planSkills([], [{ target: "org-mine", marker: null, copyHash: null }]);
    expect(p).toEqual([]);
  });

  it("混合场景：各分支互不干扰", () => {
    const p = planSkills(
      [src("new", "h"), src("same", "h1"), src("moved", "h2"), src("theirs", "h")],
      [
        { target: "org-same", marker: mk("same", "h1", "c1"), copyHash: "c1" },
        { target: "org-moved", marker: mk("moved", "h1", "c1"), copyHash: "c1" },
        { target: "org-theirs", marker: null, copyHash: null },
        { target: "org-orphan", marker: mk("orphan", "h", "c1"), copyHash: "c1" },
        { target: "my-own", marker: null, copyHash: null },
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
    // 424242 而非 99999：99999 在 macOS 上恰好是 PID_MAX，理论上可能真的被
    // 某个进程占用，会让这条测试偶发变红；424242 超出常见 pid 上限，稳妥。
    write(skills, `org-a${TMP_SUFFIX}424242/SKILL.md`, "半成品\n");

    syncSkills(kb, home);
    const left = fs.readdirSync(skills).filter((n) => n.includes(TMP_SUFFIX));
    expect(left).toEqual([]);
  });

  it("cleanTmpDirs 只清 pid 已不存活的临时目录，活 pid 的原样保留", () => {
    // I1 的回归护栏：sync7 只验证「死 pid 被清」，无差别删除的旧实现在那条
    // 用例下同样是绿的，测不出「活 pid 必须被保留」这条不变式。这里用测试
    // 进程自己的 pid（process.pid，必然存活）构造一个 tmp 目录，混一个用不
    // 可能存在的 pid 构造的死目录，断言前者原样保留、后者被清。
    const kb = tmpDir("sync-pidgate-kb");
    const { home, skills } = fakeHome("sync-pidgate-home");
    fs.mkdirSync(skills, { recursive: true });

    const liveName = `org-ghost${TMP_SUFFIX}${process.pid}`;
    const deadName = `org-ghost${TMP_SUFFIX}999999999`;
    write(skills, `${liveName}/SKILL.md`, "另一进程正在写\n");
    write(skills, `${deadName}/SKILL.md`, "上次崩溃残留\n");

    syncSkills(kb, home);

    expect(fs.existsSync(path.join(skills, liveName))).toBe(true);
    expect(fs.existsSync(path.join(skills, deadName))).toBe(false);
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

  it("手改托管副本内容 → 下个周期被静默覆盖（自愈重装）", () => {
    // I3：marker 只存源哈希时，手改副本连跑多轮都不会被发现。装好副本哈希
    // (copyHash) 之后，手改内容 / 塞进的额外文件都必须在下一次 syncSkills
    // 被抹掉——这是文件头注释与设计文档承诺的「单向分发，手改被静默覆盖」。
    const kb = tmpDir("sync12-kb");
    const { home, skills } = fakeHome("sync12-home");
    seedSkill(kb, "a");
    syncSkills(kb, home);

    const dest = path.join(skills, "org-a");
    fs.writeFileSync(path.join(dest, "SKILL.md"), "---\nname: org-a\n---\n\n被手改了\n");
    write(skills, "org-a/后门.md", "植入的文件\n");

    const changes = syncSkills(kb, home);
    expect(changes.map((c) => c.action)).toEqual(["updated"]);
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).not.toContain("被手改了");
    expect(fs.existsSync(path.join(dest, "后门.md"))).toBe(false);
  });

  it("坏标记（JSON 截断 / 字面 null / 字段类型错误）不被认作托管，目录原样保留", () => {
    // I2：readMarker 的字段校验是整个功能唯一的删除闸门。构造「目标存在但源
    // 已消失」的孤儿场景（kb 里没有对应源），如果坏标记被误认成有效标记，
    // removed 分支会把这个目录 rm -rf 掉；正确实现应该把它当 marker: null，
    // 完全不碰。"null" 这一条最容易漏：JSON.parse("null") 不抛错、合法返回
    // null，很容易被写成 `if (!m) return null` 之外没有其他校验就漏掉类型检查。
    const badMarkers = [
      ['{"source":"a"', "JSON 截断"],
      ["null", "字面 null"],
      ['{"source":123,"hash":"h"}', "字段类型错误"],
    ] as const;

    for (const [bad, label] of badMarkers) {
      const kb = tmpDir("sync13-kb");
      const { home, skills } = fakeHome("sync13-home");
      write(skills, "org-a/SKILL.md", "---\nname: org-a\n---\n\n原内容\n");
      write(skills, `org-a/${MARKER_NAME}`, bad);

      const changes = syncSkills(kb, home);
      expect(changes, label).toEqual([]);
      expect(fs.existsSync(path.join(skills, "org-a")), label).toBe(true);
      expect(
        fs.readFileSync(path.join(skills, "org-a", "SKILL.md"), "utf8"),
        label
      ).toContain("原内容");
    }
  });

  it("一个 skill 落盘失败不拖垮其余：failed 记录、tmp 清理干净、坏的那个原内容保留", () => {
    const kb = tmpDir("sync14-kb");
    const { home, skills } = fakeHome("sync14-home");
    seedSkill(kb, "good");
    seedSkill(kb, "bad");
    syncSkills(kb, home);

    // 改动两个源的内容，让 planSkills 对两者都判 updated——bad 那个会走到
    // installSkill 里的 rmSync(finalDir)，因为目标目录被 chmod 成只读而失败。
    write(kb, "skills/good/SKILL.md", "---\nname: good\ndescription: d\n---\n\n新内容\n");
    write(kb, "skills/bad/SKILL.md", "---\nname: bad\ndescription: d\n---\n\n新内容\n");

    const badDir = path.join(skills, "org-bad");
    const before = fs.readFileSync(path.join(badDir, "SKILL.md"), "utf8");
    fs.chmodSync(badDir, 0o500); // r-x：目录内条目不可删，rmSync(finalDir) 会失败

    try {
      const changes = syncSkills(kb, home);
      const byName = Object.fromEntries(changes.map((c) => [c.name, c.action]));
      expect(byName.good).toBe("updated");
      expect(byName.bad).toBe("failed");

      expect(fs.readFileSync(path.join(skills, "org-good", "SKILL.md"), "utf8")).toContain(
        "新内容"
      );
      // 坏的那个失败前的原内容必须完好，没有被半途替换
      expect(fs.readFileSync(path.join(badDir, "SKILL.md"), "utf8")).toBe(before);

      const left = fs.readdirSync(skills).filter((n) => n.includes(TMP_SUFFIX));
      expect(left).toEqual([]);
    } finally {
      // 改回可写，否则后续任何清理都会因权限失败
      fs.chmodSync(badDir, 0o755);
    }
  });

  it("用户自己叫 org- 前缀、无标记、源里也没有同名的私人 skill 完全不受影响", () => {
    // M6：sync6 测的是不带 org- 前缀的 my-own，那个方向本来就没有代码会碰，
    // 判别力很低。这里用带 org- 前缀但不是我们装的目录，才是真正贴着
    // readExistingTargets「只看 org- 前缀」这条边界的用例。
    const kb = tmpDir("sync15-kb");
    const { home, skills } = fakeHome("sync15-home");
    seedSkill(kb, "a");
    write(skills, "org-mine/SKILL.md", "---\nname: org-mine\n---\n\n私人\n");

    const changes = syncSkills(kb, home);
    expect(changes.some((c) => c.target === "org-mine")).toBe(false);
    expect(fs.readFileSync(path.join(skills, "org-mine", "SKILL.md"), "utf8")).toContain("私人");
  });

  it("~/.claude/skills/org-a 是普通文件而非目录 → 判为 foreign，不被删除覆盖", () => {
    // M3：readExistingTargets 若按「不是目录就跳过」过滤，这种目标会从
    // existing 里消失，导致 planSkills 误判 created，installSkill 再对一个
    // 普通文件做 rmSync(recursive:true) 静默删掉它——破坏「无标记一律不碰」。
    const kb = tmpDir("sync16-kb");
    const { home, skills } = fakeHome("sync16-home");
    seedSkill(kb, "a");
    fs.mkdirSync(skills, { recursive: true });
    fs.writeFileSync(path.join(skills, "org-a"), "我是个文件，不是目录\n");

    const changes = syncSkills(kb, home);
    expect(changes.map((c) => c.action)).toEqual(["foreign"]);
    expect(fs.readFileSync(path.join(skills, "org-a"), "utf8")).toBe("我是个文件，不是目录\n");
  });
});

describe("uninstallSkills", () => {
  it("清掉托管副本，保留用户自己的 skill 与自建的 org-*", () => {
    const kb = tmpDir("uninst-kb");
    const { home, skills } = fakeHome("uninst-home");
    seedSkill(kb, "a");
    seedSkill(kb, "b");
    syncSkills(kb, home);
    write(skills, "my-own/SKILL.md", "---\nname: my-own\n---\n私人\n");
    write(skills, "org-handmade/SKILL.md", "---\nname: org-handmade\n---\n手写\n");

    const removals = uninstallSkills(home);
    expect(removals.filter((r) => r.removed).map((r) => r.target).sort()).toEqual([
      "org-a",
      "org-b",
    ]);
    expect(fs.existsSync(path.join(skills, "org-a"))).toBe(false);
    expect(fs.existsSync(path.join(skills, "org-b"))).toBe(false);
    expect(fs.existsSync(path.join(skills, "my-own", "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(skills, "org-handmade", "SKILL.md"), "utf8")).toContain(
      "手写"
    );
  });

  it("目标目录不存在 → 空结果、不抛错", () => {
    const { home } = fakeHome("uninst-empty");
    expect(uninstallSkills(home)).toEqual([]);
  });

  it("顺手清掉残留临时目录", () => {
    const { home, skills } = fakeHome("uninst-tmp");
    write(skills, `org-x${TMP_SUFFIX}12345/SKILL.md`, "半成品\n");
    uninstallSkills(home);
    expect(fs.readdirSync(skills).filter((n) => n.includes(TMP_SUFFIX))).toEqual([]);
  });
});
