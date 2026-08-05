# 团队 skills 分发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把知识库 `skills/` 下的 Claude Code skill 单向拷贝分发到本机 `~/.claude/skills/org-<name>/`，随知识库自动更新，用户零操作。

**Architecture:** 新增 `src/skills-sync.ts`，完全复刻 `src/agent-config.ts` 已验证的形状——一个 `syncSkills(kbDir, home?)` 被 `init` 与守护进程周期共同调用，内容哈希相同则不落盘；一个 `uninstallSkills(home?)` 供 `uninstall` 调用。决策逻辑抽成纯函数（`prefixedName` / `rewriteSkillName` / `planSkills`）与 fs 副作用分离，便于单测。

**Tech Stack:** TypeScript (ESM, NodeNext)、Node ≥18 内置模块（`node:fs` / `node:path` / `node:os` / `node:crypto`）、vitest 2.x、commander 12.x。不引入任何新依赖。

## Global Constraints

- 设计依据：[docs/superpowers/specs/2026-08-05-skills-sync-design.md](../specs/2026-08-05-skills-sync-design.md)。有冲突时以 spec 为准。
- **所有注释、日志、CLI 输出、README 文案一律简体中文**，与现有代码一致。
- 注释写「为什么这样做 / 不这样做会怎样」，不写「这行在做什么」。参考 `src/agent-config.ts` 的注释密度与语气。
- **不引入新的 npm 依赖。**
- 常量：源子目录 `skills`、目标前缀 `org-`、标记文件名 `.knowbase.json`、临时目录后缀 `.knowbase-tmp-`。
- 目标目录名合法性正则：`^[A-Za-z0-9][A-Za-z0-9._-]*$`。
- 分发只对 Claude Code（`~/.claude/skills`）生效。Codex 无 skills 目录机制，不做多目标抽象。
- 每个任务结束时 `npm run build && npm test` 必须全绿；`npx tsc --noEmit -p tsconfig.json` 必须无错。
- **`npm test` 之前必须 `npm run build`。** `test/cli.test.ts` 跑的是编译产物 `dist/cli.js`（通过 `knowbase()` 辅助函数 spawn 子进程）。改了 `src/` 不重新 build，这些端到端用例会静默地跑在旧 `dist` 上——通过也不能证明你的改动是对的。
- **测试文件归属**：本项目**没有** `test/config.test.ts` / `test/init.test.ts` / `test/status.test.ts`。CLI 层行为（init 选项、配置持久化、status 输出、uninstall）一律测在 `test/cli.test.ts`，用它已有的 `knowbase(args, extraEnv?)` 辅助函数 spawn 真实 CLI，`HOME` 与 `XDG_CONFIG_HOME` 已由该函数注入临时目录。模块级函数（如 `refreshOrgSkills`）测在对应的 `test/<module>.test.ts`，直接 import 并传显式 `home` 参数——照 `test/sync-engine.test.ts` 里 `describe("refreshAgentPrompts")` 那一段的写法。
- **不要为了可测性给 `cmdStatus` / `cmdInit` 增加 `home` 参数。** 端到端测试是 spawn 子进程 + 注入 `HOME`，`os.homedir()` 在子进程里自然解析到临时目录，签名不用动。
- **注意 `tsconfig.json` 的 `exclude` 含 `test`**：`tsc` 不检查测试文件，vitest 也只转译不做类型检查。所以测试里的类型错误**两个命令都抓不到**——写测试时对着 Task 的 `Produces` 签名手工核对参数与返回类型，别指望工具兜底。
- 测试里凡涉及 `~`，一律传显式的临时 `home` 参数，**绝不**依赖 `os.homedir()`——否则跑测试会污染开发者本机的 `~/.claude/skills`。
- 每个任务末尾单独 commit，遵循现有 conventional commits 风格（`feat(skills):` / `test(skills):` / `docs:`）。commit message 用中文正文。

---

### Task 1: 命名与 frontmatter 改写（纯函数）

**Files:**
- Create: `src/skills-sync.ts`
- Create: `test/skills-sync.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export const SKILLS_SUBDIR = "skills"`
  - `export const ORG_PREFIX = "org-"`
  - `export const MARKER_NAME = ".knowbase.json"`
  - `export const TMP_SUFFIX = ".knowbase-tmp-"`
  - `export function prefixedName(name: string): string | null`
  - `export function rewriteSkillName(md: string, newName: string): string | null`

- [ ] **Step 1: 写失败的测试**

创建 `test/skills-sync.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/skills-sync.test.ts`
Expected: FAIL，报 `Failed to resolve import "../src/skills-sync.js"`

- [ ] **Step 3: 写最小实现**

创建 `src/skills-sync.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 把知识库 skills/ 下的 Claude Code skill 单向分发到本机 ~/.claude/skills/。
 *
 * 单向：托管副本是只读分发产物，在 ~/.claude/skills/ 里手改不回写知识库，
 * 下个周期被静默覆盖。贡献路径只有一条——编辑知识库 skills/ 目录。
 *
 * 只对 Claude Code 生效：Codex 没有 skills 目录机制，因此这里不做
 * agent-config.ts 那种多目标抽象。
 */

/** 知识库中存放 skill 的子目录。 */
export const SKILLS_SUBDIR = "skills";

/**
 * 托管副本的目录名前缀。
 * 两个作用：skill 列表里一眼看出哪些是团队的；从机制上消除与成员个人 skill
 * 同名的可能——统一加前缀比「同名时跳过」更好，后者会让该成员静默拿不到团队版。
 */
export const ORG_PREFIX = "org-";

/** 托管标记文件名，兼作所有权证明与变更检测。 */
export const MARKER_NAME = ".knowbase.json";

/** 临时目录后缀，实际目录名还会拼上 pid。 */
export const TMP_SUFFIX = ".knowbase-tmp-";

/**
 * 合法目录名。这是**安全要求**，不是洁癖：源目录名来自共享仓库（任何有写权限的
 * 成员都能改），且会直接拼进 ~/.claude/skills/ 的路径。不校验则 `../../` 这类
 * 名字能让写入落到 home 目录任意位置。
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 源目录名 → 托管副本目录名。名字不合法返回 null。 */
export function prefixedName(name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  return name.startsWith(ORG_PREFIX) ? name : ORG_PREFIX + name;
}

/**
 * 改写 SKILL.md frontmatter 中的 name 字段，使其与托管目录名一致。
 * 无 frontmatter / 未闭合 / 无 name 字段返回 null——那不是一个合法 skill。
 *
 * 必须改写而不是只改目录名：本机现有样本中目录名与 name 字段全部一致，
 * 无法判定 Claude Code 按哪个识别 skill。既然是拷贝分发，改写副本可以彻底
 * 消掉这个不确定性——两种识别规则下都正确。
 */
export function rewriteSkillName(md: string, newName: string): string | null {
  const lines = md.split("\n");
  // trimEnd 兼容 CRLF 检出（Windows 上 git 可能把 \n 转成 \r\n）
  if (lines[0]?.trimEnd() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  for (let i = 1; i < end; i++) {
    if (!/^name:\s*/.test(lines[i])) continue;
    // 保留该行原有的 \r，避免把 CRLF 文件改成混合行尾
    const cr = lines[i].endsWith("\r") ? "\r" : "";
    lines[i] = `name: ${newName}${cr}`;
    return lines.join("\n");
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/skills-sync.test.ts`
Expected: PASS，11 个用例全绿

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无输出。`tsconfig.json` 没开 `noUnusedLocals`，所以 Task 1 里 `fs` / `os` / `crypto` 暂时用不上也不会报错，照写不用删。

- [ ] **Step 6: Commit**

```bash
git add src/skills-sync.ts test/skills-sync.test.ts
git commit -m "feat(skills): 目录名前缀与 SKILL.md name 字段改写"
```

---

### Task 2: 源目录扫描与内容哈希

**Files:**
- Modify: `src/skills-sync.ts`
- Modify: `test/skills-sync.test.ts`

**Interfaces:**
- Consumes: `prefixedName`、`rewriteSkillName`、`SKILLS_SUBDIR`（Task 1）
- Produces:
  - `export interface SkillFiles { files: string[]; symlinks: string[] }`
  - `export function listSkillFiles(dir: string): SkillFiles`
  - `export function hashSkillDir(dir: string): string`
  - `export interface SkillSource { name: string; dir: string; target: string; hash: string }`
  - `export type SkillAction = "created" | "updated" | "unchanged" | "foreign" | "removed" | "invalid" | "failed"`
  - `export interface SkillChange { name: string; target: string; action: SkillAction; reason?: string }`
  - `export function readSkillSources(kbDir: string): { sources: SkillSource[]; invalid: SkillChange[] }`

- [ ] **Step 1: 写失败的测试**

追加到 `test/skills-sync.test.ts`（顶部 import 补上新符号，并加 `import fs from "node:fs"; import path from "node:path"; import { tmpDir, write } from "./helpers.js";`）：

```ts
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

  it("仅大小写不同的重名 → 取排序第一个，其余 invalid", () => {
    // 大小写不敏感的文件系统上无法同时落盘 Foo 与 foo，因此直接测纯函数
    // 层面的去重：用 aFoo / Afoo 这两个能共存、且 target 小写相同的名字。
    const kb = tmpDir("skills-src4");
    seedSkill(kb, "Afoo");
    seedSkill(kb, "afoo");
    const r = readSkillSources(kb);
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0].name).toBe("Afoo");
    expect(r.invalid).toHaveLength(1);
    expect(r.invalid[0].name).toBe("afoo");
    expect(r.invalid[0].reason).toContain("大小写");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/skills-sync.test.ts`
Expected: FAIL，报 `listSkillFiles is not exported` / `is not a function`

- [ ] **Step 3: 写最小实现**

追加到 `src/skills-sync.ts`：

```ts
export interface SkillFiles {
  /** 排序后的相对路径，统一用 / 分隔。 */
  files: string[];
  /** 被跳过的软链相对路径，供调用方记日志。 */
  symlinks: string[];
}

/**
 * 列出 skill 目录下所有普通文件。
 *
 * 哈希与拷贝**必须**共用这个函数：两者看到的文件集合一旦不一致，就会出现
 * 「哈希说没变、副本其实缺文件」这种无法自愈的状态。
 *
 * 软链跳过：git 会存软链，而一条指向作者机器路径的软链拷到别人机器上必然
 * 悬空——静默留一条坏链比缺一个文件更难查。
 */
export function listSkillFiles(dir: string): SkillFiles {
  const files: string[] = [];
  const symlinks: string[] = [];
  const walk = (cur: string, prefix: string): void => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      // 防御性：正常的 org-kb 里 skill 目录下不会有嵌套仓库
      if (e.name === ".git") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        symlinks.push(rel);
        continue;
      }
      if (e.isDirectory()) walk(path.join(cur, e.name), rel);
      else if (e.isFile()) files.push(rel);
    }
  };
  walk(dir, "");
  return { files: files.sort(), symlinks: symlinks.sort() };
}

/**
 * 源目录内容哈希：相对路径 + 可执行位 + 文件字节，按路径字典序喂进同一个 sha256。
 *
 * - 含路径：否则源里增删文件（内容集合不变时）检测不到。
 * - 排序：否则结果依赖目录遍历顺序，跨平台不稳定。
 * - 含可执行位：skill 可能带脚本，chmod +x 而内容不变时也必须重新分发。
 */
export function hashSkillDir(dir: string): string {
  const h = crypto.createHash("sha256");
  for (const rel of listSkillFiles(dir).files) {
    const full = path.join(dir, rel);
    const st = fs.statSync(full);
    h.update(rel, "utf8");
    h.update("\0");
    h.update((st.mode & 0o111) !== 0 ? "1" : "0");
    h.update("\0");
    h.update(fs.readFileSync(full));
    h.update("\0");
  }
  return h.digest("hex");
}

export interface SkillSource {
  /** 知识库里的原目录名。 */
  name: string;
  /** 源目录绝对路径。 */
  dir: string;
  /** 托管副本目录名（org- 前缀后）。 */
  target: string;
  /** 源目录内容哈希。 */
  hash: string;
}

/**
 * created/updated/unchanged/foreign/removed 是 planSkills 的决策；
 * invalid 来自源侧校验；failed 是落盘阶段的失败结果。
 */
export type SkillAction =
  | "created"
  | "updated"
  | "unchanged"
  | "foreign"
  | "removed"
  | "invalid"
  | "failed";

export interface SkillChange {
  /** 源名。invalid 时是被跳过的目录名。 */
  name: string;
  /** 托管副本目录名。invalid 时为空串。 */
  target: string;
  action: SkillAction;
  /** invalid / foreign / failed 的原因，用于日志与 status。 */
  reason?: string;
}

/**
 * 扫描 <kbDir>/skills 下的一级子目录，校验并计算哈希。
 * skills/ 不存在时返回空结果、绝不抛错——大多数团队 day one 还没有这个目录。
 */
export function readSkillSources(kbDir: string): {
  sources: SkillSource[];
  invalid: SkillChange[];
} {
  const root = path.join(kbDir, SKILLS_SUBDIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { sources: [], invalid: [] };
  }

  const sources: SkillSource[] = [];
  const invalid: SkillChange[] = [];
  const bad = (name: string, reason: string): void => {
    invalid.push({ name, target: "", action: "invalid", reason });
  };

  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const target = prefixedName(name);
    if (!target) {
      bad(name, "目录名不合法（只允许 A-Za-z0-9 开头，含 . _ -）");
      continue;
    }
    const dir = path.join(root, name);
    const mdPath = path.join(dir, "SKILL.md");
    let md: string;
    try {
      md = fs.readFileSync(mdPath, "utf8");
    } catch {
      bad(name, "缺少 SKILL.md");
      continue;
    }
    if (rewriteSkillName(md, target) === null) {
      bad(name, "SKILL.md 缺少 frontmatter 或 name 字段");
      continue;
    }
    let hash: string;
    try {
      hash = hashSkillDir(dir);
    } catch (err) {
      bad(name, `读取失败：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    sources.push({ name, dir, target, hash });
  }

  // 仅大小写不同的重名必须定死取值：macOS 大小写不敏感、Linux 敏感，不定死会
  // 产生「同一知识库在不同成员机器上行为不同」的极难排查问题。entries 已按名字
  // 排序，因此先到的就是排序第一个。
  const seen = new Map<string, string>();
  const deduped: SkillSource[] = [];
  for (const s of sources) {
    const key = s.target.toLowerCase();
    const winner = seen.get(key);
    if (winner === undefined) {
      seen.set(key, s.name);
      deduped.push(s);
      continue;
    }
    bad(s.name, `与 ${winner} 仅大小写不同，已跳过`);
  }

  return { sources: deduped, invalid };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/skills-sync.test.ts`
Expected: PASS

- [ ] **Step 5: 全量测试与类型检查**

Run: `npm run build && npm test && npx tsc --noEmit -p tsconfig.json`
Expected: 全绿、无类型错误

- [ ] **Step 6: Commit**

```bash
git add src/skills-sync.ts test/skills-sync.test.ts
git commit -m "feat(skills): 源目录扫描、校验与内容哈希"
```

---

### Task 3: 分发决策（纯函数 planSkills）

**Files:**
- Modify: `src/skills-sync.ts`
- Modify: `test/skills-sync.test.ts`

**Interfaces:**
- Consumes: `SkillSource`、`SkillChange`（Task 2）
- Produces:
  - `export interface SkillMarker { source: string; hash: string; syncedAt: string }`
  - `export interface ExistingTarget { target: string; marker: SkillMarker | null }`
  - `export function planSkills(sources: SkillSource[], existing: ExistingTarget[]): SkillChange[]`

- [ ] **Step 1: 写失败的测试**

追加到 `test/skills-sync.test.ts`，并把 `planSkills` 与类型 `SkillSource` / `SkillMarker` 补进顶部 import：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/skills-sync.test.ts -t planSkills`
Expected: FAIL，`planSkills is not a function`

- [ ] **Step 3: 写最小实现**

追加到 `src/skills-sync.ts`：

```ts
export interface SkillMarker {
  /** 源目录名（知识库里的原名）。 */
  source: string;
  /** 落盘时的源内容哈希。 */
  hash: string;
  syncedAt: string;
}

export interface ExistingTarget {
  /** ~/.claude/skills 下的目录名。 */
  target: string;
  /** 读到的托管标记；不是 knowbase 托管的为 null。 */
  marker: SkillMarker | null;
}

/**
 * 纯决策：源列表 + 目标现状 → 动作列表。不碰文件系统，便于把六个分支都测到。
 *
 * 无标记的目标一律不碰——包括用户自己恰好叫 org-xxx 的 skill。所有权信息放在
 * 目录内的标记文件而非集中式 state，是为了让孤儿识别自愈：state 文件丢失会让
 * 托管副本永久变成无人认领的垃圾，标记在目录内则永远认得出来。
 */
export function planSkills(
  sources: SkillSource[],
  existing: ExistingTarget[]
): SkillChange[] {
  const changes: SkillChange[] = [];
  const byTarget = new Map(existing.map((e) => [e.target, e]));
  const wanted = new Set<string>();

  for (const s of sources) {
    wanted.add(s.target);
    const cur = byTarget.get(s.target);
    if (!cur) {
      changes.push({ name: s.name, target: s.target, action: "created" });
      continue;
    }
    if (!cur.marker) {
      changes.push({
        name: s.name,
        target: s.target,
        action: "foreign",
        reason: "同名目录不是 knowbase 托管的，未覆盖",
      });
      continue;
    }
    changes.push({
      name: s.name,
      target: s.target,
      action: cur.marker.hash === s.hash ? "unchanged" : "updated",
    });
  }

  // 反向扫：托管副本的源已不在列表中 → 孤儿。覆盖「知识库里删了 skill」与
  // 「重命名了 skill」两种情况。
  for (const e of existing) {
    if (!e.marker) continue;
    if (wanted.has(e.target)) continue;
    changes.push({ name: e.marker.source, target: e.target, action: "removed" });
  }

  return changes;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/skills-sync.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无输出

- [ ] **Step 6: Commit**

```bash
git add src/skills-sync.ts test/skills-sync.test.ts
git commit -m "feat(skills): 分发决策纯函数 planSkills"
```

---

### Task 4: 落盘（syncSkills）

**Files:**
- Modify: `src/skills-sync.ts`
- Modify: `test/skills-sync.test.ts`

**Interfaces:**
- Consumes: 全部 Task 1–3 的导出
- Produces:
  - `export function skillsHomeDir(home?: string): string`
  - `export function readExistingTargets(skillsHome: string): ExistingTarget[]`
  - `export function syncSkills(kbDir: string, home?: string): SkillChange[]`

- [ ] **Step 1: 写失败的测试**

追加到 `test/skills-sync.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/skills-sync.test.ts -t syncSkills`
Expected: FAIL，`syncSkills is not a function`

- [ ] **Step 3: 写最小实现**

追加到 `src/skills-sync.ts`：

```ts
/** 托管副本落地目录。只有 Claude Code 有这个机制。 */
export function skillsHomeDir(home: string = os.homedir()): string {
  return path.join(home, ".claude", "skills");
}

/**
 * 读取目标目录现状。
 *
 * 只看 org- 前缀的目录：我们的目标名恒以 org- 开头（prefixedName 保证），
 * 因此非 org- 目录既不可能是目标、也不可能是我们的，跳过既安全又省去每周期
 * 对用户全部个人 skill 的无谓探测。
 */
export function readExistingTargets(skillsHome: string): ExistingTarget[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsHome, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ExistingTarget[] = [];
  for (const e of entries) {
    // 软链目标（dotfiles 仓库常这么做）也算目录，用 statSync 而非 isDirectory
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (!e.name.startsWith(ORG_PREFIX)) continue;
    if (e.name.includes(TMP_SUFFIX)) continue;
    out.push({ target: e.name, marker: readMarker(path.join(skillsHome, e.name)) });
  }
  return out;
}

function readMarker(dir: string): SkillMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER_NAME), "utf8")) as
      | Partial<SkillMarker>
      | null;
    // 字段校验后才认所有权：一个被截断或被手改坏的标记不该让我们 rm -rf 这个目录
    if (!m || typeof m.source !== "string" || typeof m.hash !== "string") return null;
    return { source: m.source, hash: m.hash, syncedAt: String(m.syncedAt ?? "") };
  } catch {
    return null;
  }
}

/** 清掉上次崩溃残留的临时目录。 */
function cleanTmpDirs(skillsHome: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(skillsHome);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.includes(TMP_SUFFIX)) continue;
    try {
      fs.rmSync(path.join(skillsHome, n), { recursive: true, force: true });
    } catch {
      // 清不掉不影响本次分发
    }
  }
}

/**
 * 整体替换式安装：临时目录 + rename。
 *
 * - 不做增量：源里删了文件，增量拷贝检测不到，副本里会残留幽灵文件。
 * - 临时目录 + rename：避免「删了旧的、拷贝中途崩溃」留下半个 skill 被
 *   Claude Code 加载。rename 始终同目录、同文件系统。
 * - 临时名带 pid：守护进程的周期刷新与用户手跑的 init 会同时写同一目标，
 *   共用固定临时名会让两个进程交错写入同一临时目录。
 */
function installSkill(src: SkillSource, skillsHome: string): void {
  const finalDir = path.join(skillsHome, src.target);
  const tmp = `${finalDir}${TMP_SUFFIX}${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const rel of listSkillFiles(src.dir).files) {
      const from = path.join(src.dir, rel);
      const to = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      // 只搬可执行位，其余权限位按默认 umask。skill 可以带脚本，丢了 +x
      // 脚本就跑不起来，而这种失败在 agent 侧极难定位。
      if ((fs.statSync(from).mode & 0o111) !== 0) fs.chmodSync(to, 0o755);
    }

    const mdPath = path.join(tmp, "SKILL.md");
    const rewritten = rewriteSkillName(fs.readFileSync(mdPath, "utf8"), src.target);
    // readSkillSources 已校验过，这里为 null 只可能是源在扫描后被改坏
    if (rewritten === null) throw new Error("SKILL.md 的 name 字段在分发过程中失效");
    fs.writeFileSync(mdPath, rewritten, "utf8");

    const marker: SkillMarker = {
      source: src.name,
      hash: src.hash,
      syncedAt: new Date().toISOString(),
    };
    // 最后写：源侧若误提交了同名文件，这一步会把它盖掉
    fs.writeFileSync(
      path.join(tmp, MARKER_NAME),
      JSON.stringify(marker, null, 2) + "\n",
      "utf8"
    );

    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmp, finalDir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/**
 * 把知识库 skills/ 分发到 ~/.claude/skills/。init 与守护进程每周期共用。
 * 单个 skill 失败记为 failed 并继续下一个：一个坏 skill 不该拖垮整批分发。
 */
export function syncSkills(kbDir: string, home: string = os.homedir()): SkillChange[] {
  const skillsHome = skillsHomeDir(home);
  cleanTmpDirs(skillsHome);

  const { sources, invalid } = readSkillSources(kbDir);
  const existing = readExistingTargets(skillsHome);
  // 源与目标都空时提前返回：不能因为「检查了一下」就凭空创建 ~/.claude/skills
  if (sources.length === 0 && existing.length === 0) return invalid;

  const plan = planSkills(sources, existing);
  const byTarget = new Map(sources.map((s) => [s.target, s]));
  const out: SkillChange[] = [...invalid];

  for (const c of plan) {
    if (c.action === "unchanged" || c.action === "foreign") {
      out.push(c);
      continue;
    }
    try {
      if (c.action === "removed") {
        fs.rmSync(path.join(skillsHome, c.target), { recursive: true, force: true });
      } else {
        const src = byTarget.get(c.target)!;
        fs.mkdirSync(skillsHome, { recursive: true });
        installSkill(src, skillsHome);
      }
      out.push(c);
    } catch (e) {
      out.push({
        name: c.name,
        target: c.target,
        action: "failed",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/skills-sync.test.ts`
Expected: PASS

如果「二次调用不落盘」用例因 mtime 精度失败（部分文件系统 mtime 只到秒），
把断言改为「`changes` 全为 `unchanged`」＋「用 `fs.readFileSync` 比对 marker 的
`syncedAt` 未变」——`syncedAt` 每次落盘都会变，是更可靠的落盘探针。

- [ ] **Step 5: 全量测试与类型检查**

Run: `npm run build && npm test && npx tsc --noEmit -p tsconfig.json`
Expected: 全绿、无类型错误

- [ ] **Step 6: Commit**

```bash
git add src/skills-sync.ts test/skills-sync.test.ts
git commit -m "feat(skills): 落盘分发 syncSkills（临时目录+rename、孤儿清理）"
```

---

### Task 5: 卸载（uninstallSkills）

**Files:**
- Modify: `src/skills-sync.ts`
- Modify: `test/skills-sync.test.ts`

**Interfaces:**
- Consumes: `readExistingTargets`、`skillsHomeDir`（Task 4）
- Produces:
  - `export interface SkillRemoval { target: string; removed: boolean }`
  - `export function uninstallSkills(home?: string): SkillRemoval[]`

- [ ] **Step 1: 写失败的测试**

追加到 `test/skills-sync.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/skills-sync.test.ts -t uninstallSkills`
Expected: FAIL，`uninstallSkills is not a function`

- [ ] **Step 3: 写最小实现**

追加到 `src/skills-sync.ts`：

```ts
export interface SkillRemoval {
  target: string;
  removed: boolean;
}

/**
 * uninstall 时调用：移除所有带托管标记的副本。
 * 无标记的目录一律不碰——包括用户自己手写的 org-* skill。
 */
export function uninstallSkills(home: string = os.homedir()): SkillRemoval[] {
  const skillsHome = skillsHomeDir(home);
  cleanTmpDirs(skillsHome);
  const removals: SkillRemoval[] = [];
  for (const e of readExistingTargets(skillsHome)) {
    if (!e.marker) continue;
    try {
      fs.rmSync(path.join(skillsHome, e.target), { recursive: true, force: true });
      removals.push({ target: e.target, removed: true });
    } catch {
      removals.push({ target: e.target, removed: false });
    }
  }
  return removals;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/skills-sync.test.ts`
Expected: PASS

- [ ] **Step 5: 全量测试与类型检查**

Run: `npm run build && npm test && npx tsc --noEmit -p tsconfig.json`
Expected: 全绿、无类型错误

- [ ] **Step 6: Commit**

```bash
git add src/skills-sync.ts test/skills-sync.test.ts
git commit -m "feat(skills): uninstallSkills 移除托管副本"
```

---

### Task 6: 配置开关与 init 接入

**Files:**
- Modify: `src/config.ts:19-32`（`Config` 接口）、`src/config.ts:141-159`（`loadConfig`）
- Modify: `src/commands/init.ts:16-22`（`InitOptions`）、`:184-190`（保存配置）、`:206` 之后（调用）
- Modify: `src/cli.ts:41` 之后（新增 `--no-skills` 选项）
- Modify: `test/cli.test.ts`（在 `describe("CLI 端到端（真实运行 dist/cli.js）")` 内，紧跟现有的 `it("agentConfig 开关持久化进 config.json")` 之后）

**Interfaces:**
- Consumes: `syncSkills`（Task 4）
- Produces: `Config.skills?: boolean`（`loadConfig` 默认 `true`）；`InitOptions.skills?: boolean`

- [ ] **Step 1: 写失败的测试**

先在 `test/cli.test.ts` 里加一个共用辅助函数（放在文件内已有的 `makeDenyDryRunShim`
之后、`beforeEach` 之前）。Task 8 也用它，所以必须抽出来，不要在每个用例里重复：

```ts
/**
 * 往 bare 远端推一个合法 skill，让后续 init 克隆时自然带下来。
 * label 只用于隔离每个用例的临时 clone 目录。
 */
function seedRemoteSkill(name: string, label: string): void {
  const seed = path.join(root, `seed-${label}`);
  g(root, "clone", bare, seed);
  const dir = path.join(seed, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: 演示\n---\n\n步骤一\n`
  );
  g(seed, "add", "-A");
  g(seed, "commit", "-m", `add skill ${name}`);
  g(seed, "push", "origin", "HEAD:main");
}
```

再追加两个用例（紧跟现有的 `it("agentConfig 开关持久化进 config.json")` 之后）：

```ts
it("init 默认分发团队 skills 并持久化 skills 开关", () => {
  const kb = path.join(root, "kb");
  const cfgPath = path.join(home, ".config", "knowbase", "config.json");
  seedRemoteSkill("demo", "init-skills");

  expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
  expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).skills).toBe(true);

  const dest = path.join(home, ".claude", "skills", "org-demo");
  expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toContain("name: org-demo");
  expect(fs.existsSync(path.join(dest, ".knowbase.json"))).toBe(true);
});

it("--no-skills 跳过分发并持久化为 false", () => {
  const kb = path.join(root, "kb");
  const cfgPath = path.join(home, ".config", "knowbase", "config.json");
  seedRemoteSkill("demo", "no-skills");

  expect(knowbase(["init", bare, "--dir", kb, "--no-skills"]).code).toBe(0);
  expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).skills).toBe(false);
  expect(fs.existsSync(path.join(home, ".claude", "skills"))).toBe(false);

  // 默认 init（复用同目录）→ 开关回到 true 且补上分发
  expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
  expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).skills).toBe(true);
  expect(fs.existsSync(path.join(home, ".claude", "skills", "org-demo"))).toBe(true);
});
```

> `root` / `home` / `bare` 是 `test/cli.test.ts` 顶层的模块变量，由该文件的
> `beforeEach` 准备好；`knowbase()` 已把 `HOME` 与 `XDG_CONFIG_HOME` 注入到临时目录，
> `g()` 已从 `./helpers.js` 导入。都不用重新声明。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && npx vitest run test/cli.test.ts -t skills`
Expected: FAIL。`config.json` 里没有 `skills` 字段（`undefined`），且 `~/.claude/skills` 不存在

- [ ] **Step 3: 写实现**

`src/config.ts` —— `Config` 接口在 `agentConfig` 之后追加：

```ts
  /** 是否把知识库 skills/ 分发到 ~/.claude/skills（默认 true；init --no-skills 存 false）。 */
  skills?: boolean;
```

`loadConfig` 的返回对象在 `agentConfig` 之后追加：

```ts
    skills: parsed.skills !== false,
```

`src/cli.ts` 在 `--no-agent-config` 那行之后追加：

```ts
  .option("--no-skills", "跳过把知识库 skills/ 分发到 ~/.claude/skills")
```

`src/commands/init.ts` —— `InitOptions` 追加：

```ts
  /** commander 的 --no-skills 会把该值设为 false（默认 true）。 */
  skills?: boolean;
```

保存配置处追加：

```ts
    skills: opts.skills !== false,
```

在第 6 步（agent 提示词配置）之后新增第 7 步：

```ts
  // 7. 分发团队 skills（默认开启，--no-skills 可跳过）
  if (opts.skills === false) {
    console.log("• 已跳过团队 skills 分发（--no-skills）");
  } else {
    try {
      const changes = syncSkills(dir);
      const done = changes.filter(
        (c) => c.action === "created" || c.action === "updated"
      );
      if (done.length > 0) {
        console.log(
          `• 已分发团队 skills ${done.length} 个到 ~/.claude/skills：` +
            done.map((c) => c.target).join(", ")
        );
      } else if (changes.length === 0) {
        console.log("• 知识库暂无 skills/ 目录，跳过团队 skills 分发");
      }
      for (const c of changes) {
        if (c.action === "foreign" || c.action === "invalid" || c.action === "failed") {
          console.warn(`⚠ skill ${c.name} 未分发：${c.reason}`);
        }
      }
    } catch (e) {
      console.warn(
        `⚠ 分发团队 skills 时出错：${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
```

并在文件头部 import 处追加：

```ts
import { syncSkills } from "../skills-sync.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && npx vitest run test/cli.test.ts -t skills`
Expected: PASS

- [ ] **Step 5: 全量测试与类型检查**

Run: `npm run build && npm test && npx tsc --noEmit -p tsconfig.json`
Expected: 全绿、无类型错误

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/cli.ts src/commands/init.ts test/cli.test.ts
git commit -m "feat(skills): 新增 skills 配置开关与 init --no-skills"
```

---

### Task 7: 守护进程周期刷新

**Files:**
- Modify: `src/sync-engine.ts:16`（import）、`:309` 之后（新增函数）、`runCycle` 中调用 `refreshAgentPrompts` 处
- Modify: `test/sync-engine.test.ts`

**Interfaces:**
- Consumes: `syncSkills`（Task 4）、`Config.skills`（Task 6）
- Produces: `export function refreshOrgSkills(cfg: Config, logger: Logger, home?: string): void`

- [ ] **Step 1: 定位调用点**

Run: `grep -n "refreshAgentPrompts" src/sync-engine.ts`
把 `refreshOrgSkills` 加在同一处、紧随其后调用。两者互不依赖，顺序无关。

- [ ] **Step 2: 写失败的测试**

追加到 `test/sync-engine.test.ts`（沿用该文件已有的 `syncOnce` 调用与 `mkConfig` 方式）：

```ts
it("周期末分发团队 skills", () => {
  const root = tmpDir("engine-skills");
  const bare = makeOrigin(root);
  const dir = path.join(root, "kb");
  cloneWorkdir(bare, dir);
  const home = path.join(root, "home");
  write(dir, "skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n\n步骤\n");

  refreshOrgSkills({ ...mkConfig(bare, dir) }, new Logger(path.join(root, "log")), home);

  const md = path.join(home, ".claude", "skills", "org-demo", "SKILL.md");
  expect(fs.readFileSync(md, "utf8")).toContain("name: org-demo");
});

it("skills: false → 不写入 ~/.claude/skills", () => {
  const root = tmpDir("engine-skills-off");
  const bare = makeOrigin(root);
  const dir = path.join(root, "kb");
  cloneWorkdir(bare, dir);
  const home = path.join(root, "home");
  write(dir, "skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n\n步骤\n");

  refreshOrgSkills(
    { ...mkConfig(bare, dir), skills: false },
    new Logger(path.join(root, "log")),
    home
  );

  expect(fs.existsSync(path.join(home, ".claude", "skills"))).toBe(false);
});

it("知识库目录不存在也不抛错（失败隔离）", () => {
  const root = tmpDir("engine-skills-err");
  const logFile = path.join(root, "log");
  expect(() =>
    refreshOrgSkills(
      { ...mkConfig("u", path.join(root, "nope")) },
      new Logger(logFile),
      path.join(root, "home")
    )
  ).not.toThrow();
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/sync-engine.test.ts -t skills`
Expected: FAIL，`refreshOrgSkills is not exported`

- [ ] **Step 4: 写实现**

`src/sync-engine.ts` 第 16 行附近的 import 追加：

```ts
import { syncSkills } from "./skills-sync.js";
```

在 `refreshAgentPrompts` 函数之后追加：

```ts
/**
 * 每个同步周期末把知识库 skills/ 分发到 ~/.claude/skills。
 *
 * 与 refreshAgentPrompts 一样：纯本地读 + 写本机 ~/.claude/，不碰 git，
 * 因此不受 .knowbase-pause 影响；任何异常只记日志，不能影响 SyncResult /
 * DaemonState，也不能让守护进程退出。
 *
 * 与 refreshAgentPrompts 的**刻意不同**：这里没有 onlyExisting 语义。
 * 提示词区块在用户的个人文件里，删掉它是「别往我提示词里塞东西」最自然的
 * 表达，所以后台从不重建；而删掉 ~/.claude/skills/org-foo/ 会连标记一起
 * 删掉，「记住用户拒绝过这一个」需要引入新的持久化状态，而 opt-out 在配置层
 * 已经有了（--no-skills）。所以托管副本删掉后下个周期会被重新分发。
 * 这是单向下发 + 静默覆盖的直接推论，不是 bug，别顺手「修」掉。
 */
export function refreshOrgSkills(
  cfg: Config,
  logger: Logger,
  home?: string
): void {
  if (cfg.skills === false) return;
  try {
    const changes = syncSkills(cfg.dir, home);
    const done = changes.filter(
      (c) => c.action === "created" || c.action === "updated" || c.action === "removed"
    );
    if (done.length > 0) {
      logger.log(
        `团队 skills 已更新：${done.map((c) => `${c.target}(${c.action})`).join(", ")}`
      );
    }
    for (const c of changes) {
      if (c.action === "foreign" || c.action === "invalid" || c.action === "failed") {
        logger.log(`团队 skill ${c.name} 未分发（${c.action}）：${c.reason}`);
      }
    }
  } catch (e) {
    logger.log(
      `分发团队 skills 失败（已忽略）：${e instanceof Error ? e.message : String(e)}`
    );
  }
}
```

在 `runCycle` 里调用 `refreshAgentPrompts(...)` 的那一行之后追加（参数照抄同一行的实参）：

```ts
  refreshOrgSkills(cfg, logger, home);
```

> **注意**：`foreign` / `invalid` 会在**每个周期**都记一行日志。若人工验证时发现
> 日志刷屏，把这段改为「只在动作集合与上一周期不同时记录」——但不要为此引入
> 新的持久化状态文件，用模块级变量缓存上次的 join 结果即可。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/sync-engine.test.ts`
Expected: PASS

- [ ] **Step 6: 全量测试与类型检查**

Run: `npm run build && npm test && npx tsc --noEmit -p tsconfig.json`
Expected: 全绿、无类型错误

- [ ] **Step 7: Commit**

```bash
git add src/sync-engine.ts test/sync-engine.test.ts
git commit -m "feat(skills): 守护进程周期末分发团队 skills"
```

---

### Task 8: uninstall 接入与 status 可观测性

**Files:**
- Modify: `src/commands/uninstall.ts:11`（import）、`:48` 之后（调用）
- Modify: `src/commands/status.ts:171` 之后（新增一段）
- Modify: `test/cli.test.ts`（沿用 Task 6 加的 `seedRemoteSkill` 辅助函数）

**Interfaces:**
- Consumes: `uninstallSkills`（Task 5）、`syncSkills` 相关的 `readSkillSources` / `readExistingTargets` / `skillsHomeDir`（Task 2、4）、`Config.skills`（Task 6）
- Produces: 无新导出

- [ ] **Step 1: 写失败的测试**

追加到 `test/cli.test.ts`，紧跟现有的 `it("status 报告索引注入状态：缺失 / 已注入 / 已关闭")`
之后。`seedRemoteSkill` 已由 Task 6 加好，直接用：

```ts
it("status 报告团队 skills：暂无 / 已分发 / 已关闭", () => {
  const kb = path.join(root, "kb");

  // 知识库没有 skills/ 目录
  expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
  expect(knowbase(["status"]).out).toContain("知识库暂无 skills/ 目录");

  // 关闭
  expect(knowbase(["init", bare, "--dir", kb, "--no-skills"]).code).toBe(0);
  expect(knowbase(["status"]).out).toContain("--no-skills");
});

it("status 统计已分发的团队 skills 数量", () => {
  const kb = path.join(root, "kb");
  seedRemoteSkill("demo", "status-count");
  expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
  expect(knowbase(["status"]).out).toContain("已分发 1 个");
});

it("同名目录非托管时 status 提示未覆盖、计入需要注意并非零退出", () => {
  const kb = path.join(root, "kb");
  seedRemoteSkill("demo", "status-foreign");
  // 先手工占位 org-demo（无 .knowbase.json），模拟成员自己写过同名 skill
  const own = path.join(home, ".claude", "skills", "org-demo");
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "SKILL.md"), "---\nname: org-demo\n---\n我自己写的\n");

  expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
  const s = knowbase(["status"]);
  expect(s.out).toContain("未覆盖");
  expect(s.code).toBe(1);
  // 内容必须原样保留
  expect(fs.readFileSync(path.join(own, "SKILL.md"), "utf8")).toContain("我自己写的");
});

it("uninstall 移除托管 skills 副本，保留用户自己的 skill", () => {
  const kb = path.join(root, "kb");
  seedRemoteSkill("demo", "uninst-skill");
  expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
  expect(fs.existsSync(path.join(home, ".claude", "skills", "org-demo"))).toBe(true);

  const mine = path.join(home, ".claude", "skills", "my-own");
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, "SKILL.md"), "---\nname: my-own\n---\n私人\n");

  expect(knowbase(["uninstall"]).code).toBe(0);
  expect(fs.existsSync(path.join(home, ".claude", "skills", "org-demo"))).toBe(false);
  expect(fs.readFileSync(path.join(mine, "SKILL.md"), "utf8")).toContain("私人");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && npx vitest run test/cli.test.ts -t "团队 skills"`
Expected: FAIL，status 输出中不含「团队 skills」

- [ ] **Step 3: 写实现**

`src/commands/uninstall.ts` —— import 追加：

```ts
import { uninstallSkills } from "../skills-sync.js";
```

在移除 agent 区块那个 `try/catch` 之后追加：

```ts
  // 移除分发到 ~/.claude/skills 的团队 skills 副本（无托管标记的目录一律不碰）
  try {
    const removed = uninstallSkills().filter((r) => r.removed);
    if (removed.length > 0) {
      console.log(
        `• 已从 ~/.claude/skills 移除团队 skills ${removed.length} 个：` +
          removed.map((r) => r.target).join(", ")
      );
    }
  } catch (e) {
    console.warn(
      `⚠ 移除团队 skills 时出错：${e instanceof Error ? e.message : String(e)}`
    );
  }
```

`src/commands/status.ts` —— import 追加：

```ts
import { readExistingTargets, readSkillSources, skillsHomeDir } from "../skills-sync.js";
```

在「agent 提示词索引」那段之后追加：

```ts
  // 团队 skills（同样默认静默运行，必须给出可见性）
  console.log("");
  if (cfg.skills === false) {
    console.log("团队 skills：已关闭（init 时用了 --no-skills）");
  } else {
    const { sources, invalid } = readSkillSources(cfg.dir);
    const managed = readExistingTargets(skillsHomeDir()).filter((e) => e.marker);
    if (sources.length === 0 && managed.length === 0) {
      // 不计入 anomalies：knowbase 不播种 skills/，「还没有团队 skill」
      // 是每个团队 day one 的正常状态。
      console.log("团队 skills：已启用；知识库暂无 skills/ 目录");
    } else {
      console.log(`团队 skills：已分发 ${managed.length} 个（org-*），源 ${sources.length} 个`);
    }
    for (const c of invalid) {
      console.log(`  ⚠ 跳过 ${c.name}：${c.reason}`);
      anomalies.push(`团队 skill ${c.name} 未分发：${c.reason}`);
    }
    const foreign = sources.filter(
      (s) => !managed.some((m) => m.target === s.target) && fs.existsSync(path.join(skillsHomeDir(), s.target))
    );
    for (const s of foreign) {
      console.log(`  ⚠ 跳过 ${s.target}：同名目录不是 knowbase 托管的，未覆盖`);
      anomalies.push(
        `团队 skill ${s.name} 未分发：~/.claude/skills/${s.target} 是你自己的目录，未覆盖；改名后即可收到团队版`
      );
    }
  }
```

> 实现者注意：`status.ts` 里 `anomalies` 数组与 `fs` / `path` 的 import 是否已存在，
> 用 `grep -n "anomalies\|^import" src/commands/status.ts` 确认后按需补。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && npx vitest run test/cli.test.ts`
Expected: PASS

- [ ] **Step 5: 全量测试与类型检查**

Run: `npm run build && npm test && npx tsc --noEmit -p tsconfig.json`
Expected: 全绿、无类型错误

- [ ] **Step 6: Commit**

```bash
git add src/commands/uninstall.ts src/commands/status.ts test/cli.test.ts
git commit -m "feat(skills): uninstall 清理副本、status 展示分发情况"
```

---

### Task 9: 区块写入规范、README 与版本

**Files:**
- Modify: `src/agent-config.ts:145-147`（区块「写」那段）
- Modify: `test/agent-config.test.ts`
- Modify: `README.md`
- Modify: `package.json:3`（版本）

**Interfaces:**
- Consumes: 无
- Produces: 无新导出

- [ ] **Step 1: 写失败的测试**

追加到 `test/agent-config.test.ts` 的 `buildBlock` describe 块里：

```ts
it("区块告诉 agent 可执行流程该沉淀到 skills/", () => {
  // 不告诉 agent 这个位置存在，它永远只会往 md 里写散文，不会产出 skill
  const b = buildBlock("/kb");
  expect(b).toContain("skills/");
  expect(b).toContain("SKILL.md");
  expect(b).toContain("org-");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/agent-config.test.ts -t skills`
Expected: FAIL，区块中不含 `SKILL.md`

- [ ] **Step 3: 改区块文案**

`src/agent-config.ts` 的 `buildBlock` 里，「**写**」那一段的两个 ✅/❌ 列表项之后、
「**操作**」之前，插入一段：

```
**沉淀可执行流程**：知识库不只放散文。把「怎么做某件事」的步骤沉淀成 skill —— 写到 \`${dir}/${SKILLS_SUBDIR}/<name>/SKILL.md\`（需含 \`name\` / \`description\` 的 YAML frontmatter），knowbase 会自动分发到全团队每个人的 Claude Code。本机以 \`${ORG_PREFIX}<name>\` 出现；skill 之间互相引用时用带前缀的全名。
```

并在 `src/agent-config.ts` 头部追加 import：

```ts
import { ORG_PREFIX, SKILLS_SUBDIR } from "./skills-sync.js";
```

> **循环依赖检查**：`skills-sync.ts` 不 import `agent-config.ts`，所以这个方向是安全的。
> 若类型检查报循环，改为在 `agent-config.ts` 里内联这两个字面量并加注释指向 `skills-sync.ts`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/agent-config.test.ts`
Expected: PASS（现有断言全是 `toContain`，加一段文案不会打破它们）

- [ ] **Step 5: 更新 README**

在 README 的「与 AI agent 集成」章节之后新增一节，内容必须覆盖这几点：

- 知识库 `skills/<name>/SKILL.md` → 本机 `~/.claude/skills/org-<name>/`，守护进程每周期自动更新。
- **单向下发**：托管副本是只读产物。在 `~/.claude/skills/org-*/` 里手改**不会**回写知识库，下个周期被覆盖。要改就改知识库 `skills/` 目录。
- **删掉托管目录不是 opt-out**，下个周期会被重新分发；要关就用 `knowbase init --no-skills`（或改配置 `"skills": false`）。
- 同名保护：`~/.claude/skills/org-x` 若不是 knowbase 建的（无 `.knowbase.json`），一律不覆盖，`knowbase status` 会提示。
- 只对 Claude Code 生效；Codex 没有 skills 目录机制。
- `knowbase uninstall` 会清掉托管副本，用户自己的 skill 保留。

- [ ] **Step 6: 提版本**

`package.json` 的 `"version"` 从 `0.5.1` 改为 `0.6.0`。

- [ ] **Step 7: 全量验证**

Run: `npm run build && npm test && npx tsc --noEmit -p tsconfig.json`
Expected: 构建成功、全绿、无类型错误

- [ ] **Step 8: 端到端人工验证**

用临时 HOME 走一遍真实流程，确认托管副本真的出现在目标位置：

```bash
KB=$(mktemp -d) && HOME_T=$(mktemp -d) && mkdir -p "$KB/skills/demo" && printf '%s\n' '---' 'name: demo' 'description: 演示' '---' '' '步骤一' > "$KB/skills/demo/SKILL.md" && node -e "import('./dist/skills-sync.js').then(m=>console.log(m.syncSkills(process.argv[1],process.argv[2])))" "$KB" "$HOME_T" && find "$HOME_T/.claude/skills" -type f
```

Expected: 打印 `action: 'created'`，且 `find` 列出 `org-demo/SKILL.md` 与 `org-demo/.knowbase.json`；
`cat "$HOME_T/.claude/skills/org-demo/SKILL.md"` 中 `name:` 为 `org-demo`。

- [ ] **Step 9: Commit**

```bash
git add src/agent-config.ts test/agent-config.test.ts README.md package.json
git commit -m "feat(skills): 区块提示沉淀路径；文档与 0.6.0"
```

---

## 自查记录

对照 spec 逐节确认覆盖情况：

| spec 节 | 覆盖任务 |
|---|---|
| §3 机制选型（拷贝） | Task 4 `installSkill` |
| §4 命名与前缀、改写 `name:` | Task 1 |
| §5 源侧识别（含大小写去重、名字校验） | Task 2 |
| §6 托管标记 `.knowbase.json`、哈希算法 | Task 2（哈希）、Task 4（标记读写） |
| §7 每周期决策六分支 | Task 3（5 个）+ Task 2（`invalid`） |
| §7.1 临时目录 + rename、可执行位、软链 | Task 4 |
| §8 集成点 | Task 6（config/init/cli）、Task 7（sync-engine）、Task 8（uninstall/status）、Task 9（区块/README/版本） |
| §9.1 不用 `onlyExisting` | Task 7 的函数注释 |
| §9.2 前台 `sync` 不分发 | 不接入 `cmdSync`——Task 7 只挂 `runCycle`；README 说明在 Task 9 |
| §10 pause 不影响 | Task 7 注释；`refreshOrgSkills` 不在 pause 分支内 |
| §11 错误处理 | Task 4（`failed`）、Task 7（try/catch） |
| §12 测试计划 16 项 | Task 1–8 的测试步骤 |
| §13 可观测性 | Task 8 |

**与 spec 的一处刻意偏离**：spec §12 第 4 项要求 `planSkills` 覆盖六个分支含 `invalid`。
实现里 `invalid` 由 `readSkillSources` 在源侧校验阶段产出，`planSkills` 只处理其余五个。
理由是让 `planSkills` 的输入保持「已校验过的源」这一个不变量，比塞进一个哨兵分支更清晰。
`invalid` 的分支覆盖落在 Task 2 的 `readSkillSources` 测试里，覆盖率不减。
