# 团队 skills 分发新增 Codex 目标 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把知识库 `skills/` 的分发目标从仅 `~/.claude/skills/` 扩展为 Claude Code + Codex（`~/.codex/skills/`，存在才分发），语义与现有机制完全一致。

**Architecture:** 新增 `skillTargets()` 目标数组取代 `skillsHomeDir()` 作为唯一目标来源（门控知识集中一处）；`syncSkills` / `uninstallSkills` 内部改为对目标数组循环，`planSkills` 等纯决策层一行不动；`SkillChange` / `SkillRemoval` 增加归属字段供四个消费方（sync-engine / init / status / uninstall）分组展示。

**Tech Stack:** TypeScript（ESM, Node ≥18）、vitest。零新增运行时依赖。

**Spec:** [docs/superpowers/specs/2026-08-23-codex-skills-target-design.md](../specs/2026-08-23-codex-skills-target-design.md)

## Global Constraints

- 运行时依赖保持 2 个（commander、update-notifier），不新增。
- Codex 门控：`~/.codex` **存在且是目录**才分发；是普通文件视为未安装，跳过、不报错。
- 两端 SKILL.md 格式同构，副本内容（含 `name:` 改写、`org-` 前缀、`.knowbase.json` 标记）逐字节一致，不做任何格式转换。
- 现有不变式全部保留：无标记不碰、单 skill 失败记 failed 继续、removed 先于 created、空 target 拒绝删除、临时目录带 pid。
- 测试命令：`npx vitest run test/skills-sync.test.ts`（单文件）、`npm test`（全量）、`npm run build`（tsc 类型检查，vitest 不做类型检查所以 build 必跑）。
- 注释风格遵循项目惯例：写决策依据与约束，不写「这行在干什么」。
- 提交信息用中文 conventional commits（参考 `git log`：`feat(skills): …` / `test(skills): …` / `docs(skills): …`）。

---

### Task 1: skillTargets 目标数组与门控

**Files:**
- Modify: `src/skills-sync.ts`（在 `skillsHomeDir` 附近新增；本 task 不删 `skillsHomeDir`）
- Test: `test/skills-sync.test.ts`

**Interfaces:**
- Consumes: 无（新代码）。
- Produces: `export interface SkillTarget { name: string; dir: string }`、`export function skillTargets(home?: string): SkillTarget[]`。Task 2/3 依赖此签名。

- [ ] **Step 1: 写失败测试**

在 `test/skills-sync.test.ts` 的 `describe("uninstallSkills")` 之后追加（import 列表加 `skillTargets`）：

```ts
describe("skillTargets", () => {
  it("默认只有 Claude Code", () => {
    const home = tmpDir("targets-none");
    expect(skillTargets(home)).toEqual([
      { name: "Claude Code", dir: path.join(home, ".claude", "skills") },
    ]);
  });

  it("~/.codex 是目录 → 加入 Codex 目标", () => {
    const home = tmpDir("targets-codex");
    fs.mkdirSync(path.join(home, ".codex"));
    expect(skillTargets(home)).toEqual([
      { name: "Claude Code", dir: path.join(home, ".claude", "skills") },
      { name: "Codex", dir: path.join(home, ".codex", "skills") },
    ]);
  });

  it("~/.codex 是普通文件 → 视为未安装，不加入", () => {
    const home = tmpDir("targets-codex-file");
    fs.writeFileSync(path.join(home, ".codex"), "不是目录\n");
    expect(skillTargets(home).map((t) => t.name)).toEqual(["Claude Code"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/skills-sync.test.ts -t skillTargets`
Expected: FAIL（`skillTargets` 未导出）

- [ ] **Step 3: 最小实现**

在 `src/skills-sync.ts` 的 `skillsHomeDir` 之前加入：

```ts
export interface SkillTarget {
  /** 展示名，用于日志、status、uninstall 输出的归属标注。 */
  name: string;
  /** skills 落地目录绝对路径。 */
  dir: string;
}

/**
 * 当前生效的分发目标。Claude Code 无条件在列；Codex 仅当 ~/.codex 存在且是
 * 目录时在列——判断 ~/.codex 而非 ~/.codex/skills，装了 Codex 但从未建过
 * skills 目录的机器也该收到分发（目录由安装分支的 mkdirSync 创建）。
 * ~/.codex 是普通文件属于病态状态，视为未安装跳过即可，往文件下 mkdir 只会
 * 制造更难解释的错误。
 *
 * 每个同步周期重新求值：装 Codex 后下个周期自动开始分发，无需任何命令。
 * 门控知识只放这一处，四个消费方都从这里取目标（与 agentTargets 同一模式）。
 */
export function skillTargets(home: string = os.homedir()): SkillTarget[] {
  const targets: SkillTarget[] = [
    { name: "Claude Code", dir: path.join(home, ".claude", "skills") },
  ];
  const codexHome = path.join(home, ".codex");
  let codexInstalled = false;
  try {
    codexInstalled = fs.statSync(codexHome).isDirectory();
  } catch {
    // 不存在即未安装
  }
  if (codexInstalled) {
    targets.push({ name: "Codex", dir: path.join(codexHome, "skills") });
  }
  return targets;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/skills-sync.test.ts` 与 `npm run build`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/skills-sync.ts test/skills-sync.test.ts
git commit -m "feat(skills): skillTargets 目标数组，Codex 存在才分发的门控"
```

---

### Task 2: syncSkills / uninstallSkills 多目标化

**Files:**
- Modify: `src/skills-sync.ts`（`SkillChange`、`syncSkills`、`SkillRemoval`、`uninstallSkills`、`skillsHomeDir` 上方注释）
- Test: `test/skills-sync.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `skillTargets(home)`。
- Produces:
  - `SkillChange` 增加可选字段 `tool?: string`（目标展示名；`readSkillSources` 产出的 invalid 条目不设，因为源侧问题不属于任何目标）。`planSkills` 返回值不含 `tool`（保持纯决策层不动），由 `syncSkills` 落章。
  - `SkillRemoval` 增加必填字段 `tool: string` 与 `path: string`（副本绝对路径，删除失败时供用户手动处理——多目标后 `~/.claude/skills/<target>` 不再是唯一可能位置，消费方无法自行推出路径）。
  - `export function summarizeByTool(changes: SkillChange[], render: (c: SkillChange) => string): string`——按 `tool` 分组渲染一行摘要，如 `Claude Code org-a(created)、org-b(updated)；Codex org-a(created)`；`tool` 为空的条目不带组名前缀。Task 3 的 sync-engine 与 init 共用。
  - `syncSkills(kbDir, home?)` / `uninstallSkills(home?)` 签名不变。

- [ ] **Step 1: 写失败测试**

在 `describe("syncSkills")` 内追加（`fakeHome` 是该文件既有 helper，返回 `{ home, skills }`）：

```ts
  it("装了 Codex：双目标各得一份带独立标记的副本，tool 归属正确", () => {
    const kb = tmpDir("sync-codex-kb");
    const { home, skills } = fakeHome("sync-codex-home");
    fs.mkdirSync(path.join(home, ".codex"));
    seedSkill(kb, "a");

    const changes = syncSkills(kb, home);
    expect(changes.map((c) => [c.tool, c.action]).sort()).toEqual([
      ["Claude Code", "created"],
      ["Codex", "created"],
    ]);

    for (const dest of [
      path.join(skills, "org-a"),
      path.join(home, ".codex", "skills", "org-a"),
    ]) {
      expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toContain("name: org-a");
      expect(fs.existsSync(path.join(dest, MARKER_NAME))).toBe(true);
    }
  });

  it("装了 Codex：源删除后两个目标的副本都被撤下", () => {
    const kb = tmpDir("sync-codex-rm-kb");
    const { home, skills } = fakeHome("sync-codex-rm-home");
    fs.mkdirSync(path.join(home, ".codex"));
    seedSkill(kb, "a");
    syncSkills(kb, home);

    fs.rmSync(path.join(kb, "skills", "a"), { recursive: true });
    const changes = syncSkills(kb, home);
    expect(changes.map((c) => [c.tool, c.action]).sort()).toEqual([
      ["Claude Code", "removed"],
      ["Codex", "removed"],
    ]);
    expect(fs.existsSync(path.join(skills, "org-a"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex", "skills", "org-a"))).toBe(false);
  });

  it("一个目标写入失败不影响另一目标（目标级隔离）", () => {
    const kb = tmpDir("sync-isolate-kb");
    const { home, skills } = fakeHome("sync-isolate-home");
    seedSkill(kb, "a");
    // ~/.codex/skills 预先建成只读：cleanTmpDirs/readExistingTargets 能读，
    // installSkill 写临时目录时 EACCES → 该目标落 failed
    fs.mkdirSync(path.join(home, ".codex", "skills"), { recursive: true });
    fs.chmodSync(path.join(home, ".codex", "skills"), 0o500);
    try {
      const changes = syncSkills(kb, home);
      const byTool = new Map(changes.map((c) => [c.tool, c.action]));
      expect(byTool.get("Claude Code")).toBe("created");
      expect(byTool.get("Codex")).toBe("failed");
      expect(fs.existsSync(path.join(skills, "org-a", "SKILL.md"))).toBe(true);
    } finally {
      fs.chmodSync(path.join(home, ".codex", "skills"), 0o755);
    }
  });
```

在 `describe("uninstallSkills")` 内追加：

```ts
  it("装了 Codex：两个目标的托管副本都清掉，tool/path 字段齐全", () => {
    const kb = tmpDir("uninst-codex-kb");
    const { home, skills } = fakeHome("uninst-codex-home");
    fs.mkdirSync(path.join(home, ".codex"));
    seedSkill(kb, "a");
    syncSkills(kb, home);

    const removals = uninstallSkills(home);
    expect(removals.map((r) => [r.tool, r.target, r.removed]).sort()).toEqual([
      ["Claude Code", "org-a", true],
      ["Codex", "org-a", true],
    ]);
    for (const r of removals) {
      expect(r.path.endsWith(path.join(r.tool === "Codex" ? ".codex" : ".claude", "skills", "org-a"))).toBe(true);
      expect(fs.existsSync(r.path)).toBe(false);
    }
  });
```

新增 `describe("summarizeByTool")`：

```ts
describe("summarizeByTool", () => {
  const c = (tool: string | undefined, target: string): SkillChange =>
    ({ name: target, target, action: "created", ...(tool ? { tool } : {}) }) as SkillChange;

  it("按 tool 分组，组间分号、组内顿号", () => {
    expect(
      summarizeByTool(
        [c("Claude Code", "org-a"), c("Claude Code", "org-b"), c("Codex", "org-a")],
        (x) => `${x.target}(${x.action})`
      )
    ).toBe("Claude Code org-a(created)、org-b(created)；Codex org-a(created)");
  });

  it("tool 为空的条目不带组名前缀", () => {
    expect(summarizeByTool([c(undefined, "org-a")], (x) => x.target)).toBe("org-a");
  });
});
```

（import 列表加 `summarizeByTool`，type import 加 `SkillChange`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/skills-sync.test.ts`
Expected: 新增用例 FAIL（`tool` 恒为 undefined、`summarizeByTool` 未导出、Codex 侧无副本）

- [ ] **Step 3: 实现**

`src/skills-sync.ts` 改动四处：

(a) `SkillChange` 接口加字段（放在 `action` 之后）：

```ts
  /**
   * 目标工具展示名（skillTargets 的 name）。readSkillSources 产出的 invalid
   * 条目不设：源侧问题不属于任何目标。
   */
  tool?: string;
```

(b) `SkillRemoval` 接口加字段（放在 `target` 之后；保留现有 `removed` 语义注释）：

```ts
  /** 目标工具展示名。 */
  tool: string;
  /**
   * 副本绝对路径。多目标后消费方无法从 target 推出位置，删除失败的
   * 手动处理提示必须报出确切目录。
   */
  path: string;
```

(c) `syncSkills` 拆成外层循环 + 单目标函数。外层：

```ts
/**
 * 把知识库 skills/ 分发到所有生效目标（见 skillTargets）。init 与守护进程
 * 每周期共用。源只读一次——扫描、校验、大小写去重与目标无关；invalid 条目
 * 与目标无关，不落 tool。单个 skill 失败记为 failed 并继续下一个：一个坏
 * skill 不该拖垮整批分发；单个目标整体不可用同样不影响其他目标（该目标的
 * 条目各自落 failed，其余目标照常）。
 */
export function syncSkills(kbDir: string, home: string = os.homedir()): SkillChange[] {
  const { sources, invalid, protectedTargets } = readSkillSources(kbDir);
  const out: SkillChange[] = [...invalid];
  for (const t of skillTargets(home)) {
    out.push(...syncSkillsToTarget(sources, protectedTargets, t));
  }
  return out;
}
```

单目标函数为现有 `syncSkills` 主体的平移，仅三处差异：`skillsHome` 来自 `target.dir`；`sources/existing` 双空时返回 `[]`（invalid 已由外层收集，原早退注释的意图随注释迁移）；每个产出条目补 `tool: target.name`：

```ts
function syncSkillsToTarget(
  sources: SkillSource[],
  protectedTargets: readonly string[],
  target: SkillTarget
): SkillChange[] {
  const skillsHome = target.dir;
  cleanTmpDirs(skillsHome);
  const existing = readExistingTargets(skillsHome);
  // sources 和 existing 都空时 planSkills 必然返回空数组，这里只是提前把意图
  // 写明。它不是「不凭空创建 skills 目录」的安全网——那个由 install 分支里的
  // mkdirSync 位置保证。别在别处依赖这行当兜底。
  if (sources.length === 0 && existing.length === 0) return [];

  const plan = planSkills(sources, existing, protectedTargets);
  const byTarget = new Map(sources.map((s) => [s.target, s]));
  const out: SkillChange[] = [];

  // removed 必须先于 created/updated 执行。只改大小写的重命名（skills/foo →
  // skills/Foo）会得到 [created org-Foo, removed org-foo]，而在大小写不敏感的
  // 文件系统（macOS 默认 APFS）上这两个名字是同一个目录：先装后删会把刚装好的
  // 副本删掉。其余场景下两种顺序等价。
  const ordered = [
    ...plan.filter((c) => c.action === "removed"),
    ...plan.filter((c) => c.action !== "removed"),
  ];

  for (const c of ordered) {
    if (c.action === "unchanged" || c.action === "foreign") {
      out.push({ ...c, tool: target.name });
      continue;
    }
    try {
      if (c.action === "removed") {
        // 这是一行带 rm -rf 的代码：path.join(skillsHome, "") 等于 skillsHome
        // 本身，空 target 一旦流入就会清空整个 skills 目录。挡在这里让不变式
        // 靠代码保证，不靠「调用者不会传空 target」的默契。
        if (!c.target) throw new Error("removed 动作缺少合法 target，拒绝执行删除");
        fs.rmSync(path.join(skillsHome, c.target), { recursive: true, force: true });
      } else {
        const src = byTarget.get(c.target)!;
        fs.mkdirSync(skillsHome, { recursive: true });
        installSkill(src, skillsHome);
      }
      out.push({ ...c, tool: target.name });
    } catch (e) {
      out.push({
        name: c.name,
        target: c.target,
        tool: target.name,
        action: "failed",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}
```

（原 `syncSkills` 里 removed 顺序注释、空 target 防御注释随代码平移，不删减。）

(d) `uninstallSkills` 改为遍历目标：

```ts
/**
 * uninstall 时调用：移除所有生效目标里带托管标记的副本。
 * 无标记的目录一律不碰——包括用户自己手写的 org-* skill。
 * ~/.codex 不存在时 Codex 目标不在列（skillTargets 已滤），天然跳过。
 */
export function uninstallSkills(home: string = os.homedir()): SkillRemoval[] {
  const removals: SkillRemoval[] = [];
  for (const t of skillTargets(home)) {
    cleanTmpDirs(t.dir);
    for (const e of readExistingTargets(t.dir)) {
      if (!e.marker) continue;
      const abs = path.join(t.dir, e.target);
      try {
        fs.rmSync(abs, { recursive: true, force: true });
        removals.push({ target: e.target, tool: t.name, path: abs, removed: true });
      } catch (err) {
        removals.push({
          target: e.target,
          tool: t.name,
          path: abs,
          removed: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return removals;
}
```

(e) 新增 `summarizeByTool`（放在 `SkillChange` 定义附近）：

```ts
/**
 * 把变更按目标工具分组渲染成一行摘要：组间分号、组内顿号，如
 * 「Claude Code org-a(created)、org-b(updated)；Codex org-a(created)」。
 * tool 为空的条目（invalid）不带组名前缀。sync-engine 与 init 的日志共用，
 * 避免两处各写一套分组后格式漂移。
 */
export function summarizeByTool(
  changes: SkillChange[],
  render: (c: SkillChange) => string
): string {
  const groups = new Map<string, string[]>();
  for (const c of changes) {
    const key = c.tool ?? "";
    const arr = groups.get(key) ?? [];
    arr.push(render(c));
    groups.set(key, arr);
  }
  return [...groups.entries()]
    .map(([tool, items]) => (tool ? `${tool} ${items.join("、")}` : items.join("、")))
    .join("；");
}
```

同时改写文件头注释：删「只对 Claude Code 生效：Codex 没有 skills 目录机制，因此这里不做 agent-config.ts 那种多目标抽象」，改为「分发目标见 skillTargets：Claude Code 无条件，Codex 存在才分发。两端 SKILL.md 格式同构，副本逐字节一致」。`skillsHomeDir` 本 task 保留（status.ts 还在用，Task 3 删）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/skills-sync.test.ts` 与 `npm run build`
Expected: 全部 PASS（现有用例的 fakeHome 无 `.codex`，行为不变；断言均为 action-map / 字段级，新增可选字段不影响）

- [ ] **Step 5: 提交**

```bash
git add src/skills-sync.ts test/skills-sync.test.ts
git commit -m "feat(skills): syncSkills/uninstallSkills 多目标化，分发覆盖 Codex"
```

---

### Task 3: 四个消费方改造，删除 skillsHomeDir

**Files:**
- Modify: `src/sync-engine.ts`（`refreshOrgSkills` 及其文档注释）
- Modify: `src/commands/status.ts`（团队 skills 段，约 179–221 行）
- Modify: `src/commands/init.ts`（第 7 步分发输出，约 242–265 行）
- Modify: `src/commands/uninstall.ts`（skills 移除段，约 51–77 行）
- Modify: `src/skills-sync.ts`（删除 `skillsHomeDir`）
- Test: `test/sync-engine.test.ts`

**Interfaces:**
- Consumes: Task 1 `skillTargets()`、Task 2 `SkillChange.tool` / `SkillRemoval.{tool,path}` / `summarizeByTool(changes, render)`。
- Produces: 无新接口；`skillsHomeDir` 从导出面移除。

- [ ] **Step 1: 写失败测试**

`test/sync-engine.test.ts` 的 `describe("refreshOrgSkills")` 内追加（该 describe 现有用例展示了 `mkConfig`/`Logger` 用法，照抄其搭建方式）：

```ts
  it("装了 Codex 时同一 skill 也分发到 ~/.codex/skills", () => {
    const root = tmpDir("skills-codex");
    const { bare, dir } = makeInited(root);
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    write(dir, "skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n正文\n");

    refreshOrgSkills({ ...mkConfig(bare, dir) }, new Logger(path.join(root, "log")), home);

    for (const base of [".claude", ".codex"]) {
      const md = path.join(home, base, "skills", "org-demo", "SKILL.md");
      expect(fs.readFileSync(md, "utf8")).toContain("name: org-demo");
    }
  });
```

（`makeInited` / `mkConfig` / `write` 以该文件既有 `refreshOrgSkills` 用例（约 337–366 行）实际使用的 helper 为准，保持同一搭建方式；若既有用例用的是别的组合，照抄既有用例的搭建。）

- [ ] **Step 2: 跑测试（预期直接通过）**

Run: `npx vitest run test/sync-engine.test.ts -t Codex`
Expected: PASS——Task 2 已让 syncSkills 覆盖 Codex，refreshOrgSkills 只是透传。此用例不是 TDD 的红灯，而是把「refreshOrgSkills 透传 home、双目标生效」固化为回归项（本计划中唯一预期先绿的测试）。确认 PASS 即进入 Step 3。

- [ ] **Step 3: 改造四个消费方**

(a) `src/sync-engine.ts` `refreshOrgSkills`：import 增加 `summarizeByTool`；文档注释里「把知识库 skills/ 分发到 ~/.claude/skills」改为「分发到所有生效目标（skillTargets）」；输出两处改为：

```ts
    if (done.length > 0) {
      logger.log(`团队 skills 已更新：${summarizeByTool(done, (c) => `${c.target}(${c.action})`)}`);
    }
    for (const c of changes) {
      if (c.action === "foreign" || c.action === "invalid" || c.action === "failed") {
        const where = c.tool ? `，${c.tool}` : "";
        logger.log(`团队 skill ${c.name} 未分发（${c.action}${where}）：${c.reason}`);
      }
    }
```

同注释块中「删掉 ~/.claude/skills/org-foo/ 会连标记一起删掉」的表述保留（对两个目标同样成立），仅把路径例子改为「删掉某个目标里的 org-foo/」。

(b) `src/commands/status.ts`：import 把 `skillsHomeDir` 换成 `skillTargets`；`else` 分支改为（保留现有全部注释——planSkills 复用注释、delivered 口径注释原样跟随迁移）：

```ts
    const { sources, invalid, protectedTargets } = readSkillSources(cfg.dir);
    const targets = skillTargets();
    const perTarget = targets.map((t) => ({ t, existing: readExistingTargets(t.dir) }));
    if (sources.length === 0 && perTarget.every((p) => p.existing.every((e) => !e.marker))) {
      // 不计入 anomalies：knowbase 不播种 skills/，「还没有团队 skill」
      // 是每个团队 day one 的正常状态。
      console.log("团队 skills：已启用；知识库暂无 skills/ 目录");
    } else {
      for (const { t, existing } of perTarget) {
        const plan = planSkills(sources, existing, protectedTargets);
        const delivered = plan.filter(
          (c) => c.action === "updated" || c.action === "unchanged"
        ).length;
        console.log(`团队 skills（${t.name}）：已分发 ${delivered} 个（org-*），源 ${sources.length} 个`);
        for (const c of plan) {
          if (c.action !== "foreign") continue;
          console.log(`  ⚠ 跳过 ${c.target}：${c.reason}`);
          anomalies.push(
            `团队 skill ${c.name} 未分发：${path.join(t.dir, c.target)} 不是 knowbase 托管的，未覆盖；改名后即可收到团队版`
          );
        }
      }
      // invalid 是源侧问题，与目标无关，只报一次
      for (const c of invalid) {
        console.log(`  ⚠ 跳过 ${c.name}：${c.reason}`);
        anomalies.push(`团队 skill ${c.name} 未分发：${c.reason}`);
      }
    }
```

（原代码 invalid 在 foreign 之前打印且在 day-one 分支外；迁移后 invalid 移到目标循环后、day-one 的 else 分支内。day-one 判定为真时 sources 为空，invalid 仍可能非空——`readSkillSources` 对坏源返回 invalid 且 sources 不含它——所以 day-one 分支后仍要打印 invalid：把上面 `for (const c of invalid)` 循环放在 if/else 之后、两个分支共用。）

(c) `src/commands/init.ts` 第 7 步：import 增加 `summarizeByTool`；输出改为：

```ts
      const changes = syncSkills(dir);
      const done = changes.filter(
        (c) => c.action === "created" || c.action === "updated"
      );
      if (done.length > 0) {
        console.log(`• 已分发团队 skills：${summarizeByTool(done, (c) => c.target)}`);
      } else if (changes.length === 0) {
        console.log("• 知识库暂无 skills/ 目录，跳过团队 skills 分发");
      }
      const gone = changes.filter((c) => c.action === "removed");
      if (gone.length > 0) {
        console.log(`• 已撤下知识库中已删除的团队 skills：${summarizeByTool(gone, (c) => c.target)}`);
      }
```

（「removed 也要打印」的既有注释保留在 `gone` 之前。该段后续对 foreign/invalid/failed 的打印若引用 `~/.claude/skills` 字样，一并改为带 `c.tool` 的中性表述。）

(d) `src/commands/uninstall.ts`：成功行按 tool 分组、失败行用 `r.path`：

```ts
    const removals = uninstallSkills();
    const removed = removals.filter((r) => r.removed);
    if (removed.length > 0) {
      const groups = new Map<string, string[]>();
      for (const r of removed) {
        const arr = groups.get(r.tool) ?? [];
        arr.push(r.target);
        groups.set(r.tool, arr);
      }
      console.log(
        "• 已移除团队 skills：" +
          [...groups.entries()]
            .map(([tool, ts]) => `${tool} ${ts.length} 个（${ts.join(", ")}）`)
            .join("；")
      );
    }
    for (const r of removals) {
      if (r.removed) continue;
      console.warn(`⚠ 未能移除 ${r.path}：${r.error ?? "未知原因"}`);
      console.warn(
        `  该团队 skill 仍会被 ${r.tool} 加载，请手动删除这个目录（通常是权限问题）。`
      );
    }
```

（`removed === false` 语义的既有大段注释原样保留。）

(e) `src/skills-sync.ts`：删除 `skillsHomeDir` 函数及其注释（此时已无消费者）。

- [ ] **Step 4: 全量验证**

Run: `npm test` 与 `npm run build`
Expected: 全部 PASS。若 `test/cli.test.ts` 有断言撞上输出文案变化（`已分发团队 skills N 个到 ~/.claude/skills` → 新格式），按新格式更新断言——只允许改文案断言，不允许改行为断言。

- [ ] **Step 5: 提交**

```bash
git add src/sync-engine.ts src/commands/status.ts src/commands/init.ts src/commands/uninstall.ts src/skills-sync.ts test/sync-engine.test.ts test/cli.test.ts
git commit -m "feat(skills): 消费方按目标分组展示，移除 skillsHomeDir"
```

---

### Task 4: 注释与文档修正、版本 0.7.0

**Files:**
- Modify: `README.md`（约 116–129 行的团队 skills 节）
- Modify: `CHANGELOG.md`（顶部新增 0.7.0 段）
- Modify: `package.json`（version）

**Interfaces:** 无代码接口；纯文档。

- [ ] **Step 1: README 更新**

团队 skills 节（约 116 行起）：

1. 首段「…的 Claude Code skill，会被自动分发到团队每个成员本机的 `~/.claude/skills/org-<name>/`」改为「…的 agent skill（Claude Code 与 Codex 通用格式），会被自动分发到团队每个成员本机的 `~/.claude/skills/org-<name>/`；装了 Codex（存在 `~/.codex/` 目录）的机器还会同步分发一份到 `~/.codex/skills/org-<name>/`，装上 Codex 后下个同步周期自动生效，无需任何操作」。
2. 示意行（约 120 行）下补一行：`skills/deploy/SKILL.md      ──►    ~/.codex/skills/org-deploy/SKILL.md    (装了 Codex 时)`。
3. 删除整条「**只对 Claude Code 生效**：Codex 没有 skills 目录机制，这条分发链路不涉及 `~/.codex/`。」（约 129 行）。
4. 「单向下发」「同名保护」两条里的 `~/.claude/skills/` 字样保留（例子仍成立），但「同名保护」条补一句「Codex 侧同理」。
5. 文件布局节（约 152 行）`~/.claude/skills/org-<name>/` 行下补 `~/.codex/skills/org-<name>/    # 同上，装了 Codex 时（uninstall 移除）`。

- [ ] **Step 2: CHANGELOG 与版本号**

`package.json` 的 `version` 改为 `0.7.0`。`CHANGELOG.md` 顶部按既有条目格式新增 0.7.0 段，内容要点：团队 skills 分发新增 Codex 目标（`~/.codex/skills/`，存在才分发、每周期动态门控）；status / init / uninstall / 守护进程日志按目标分组展示；`SkillRemoval` 增加 `tool`/`path` 字段。

- [ ] **Step 3: 全量验证**

Run: `npm test` 与 `npm run build`
Expected: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "docs(skills): Codex 分发目标文档与 0.7.0"
```
