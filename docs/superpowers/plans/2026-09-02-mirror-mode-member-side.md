# 成员侧飞书镜像模式 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让成员机器上的 knowbase daemon 识别「飞书镜像仓库」并切换为只读镜像行为：关闭上行、丢弃本地改动、md 文件上只读锁、prompt 区块改为「读本地、写飞书」引导、status 展示镜像新鲜度。

**Architecture:** 仓库根存在 `.knowbase-mirror.json`（exporter 写入、随仓库分发）即自动进入镜像模式，成员零配置。新增 `src/mirror.ts` 承载清单读取、只读锁、丢弃改动、新鲜度判定；`sync-engine.ts` 的 `syncOnce` 顶部分流到 `mirrorSyncOnce`（fetch + reset --hard 语义）；`agent-config.ts` 的 `buildBlock` 增加镜像文案变体；status / uninstall 各加一小段。经典模式代码路径零改动。

**Tech Stack:** TypeScript 5.7（ESM/NodeNext，import 必须带 `.js` 后缀）、Node ≥ 18、vitest（真实 git 子进程，`fileParallelism: false` 已配置）。

**设计依据（必读）:** `docs/superpowers/specs/2026-09-02-lark-mirror-mode-design.md`（下称 spec）§4 成员侧、§5 prompt、§0 决策摘要。

## Global Constraints

- 运行时依赖只有 `commander` + `update-notifier`，**本计划不得新增任何运行时依赖**。
- 守护进程路径 never throw、never exit：任何新代码失败只记 `Logger` 日志。
- 注释用中文、解释「为什么」，重要处引用 spec 章节号（现有代码风格）。
- 测试跑法：`npx vitest run <file>`；全量 `npm test`；构建 `npm run build`（tsc）。
- 提交信息风格照旧仓库：`feat(mirror): <中文描述>`，一个 Task 一个 commit。
- 经典模式（无清单文件的仓库）行为必须完全不变——每个 Task 完成后现有测试必须全绿。
- 镜像清单 JSON 键名用 snake_case（`last_sync_at` 等）：它是与 exporter（后续计划）的跨组件契约，以 spec §3.4 为准。

---

### Task 1: 镜像清单读取与模式识别（`src/mirror.ts`）

**Files:**
- Create: `src/mirror.ts`
- Test: `test/mirror.test.ts`（新建）

**Interfaces:**
- Produces（后续 Task 全部依赖）:
  - `export const MIRROR_MANIFEST = ".knowbase-mirror.json"`
  - `export interface MirrorManifest { version: number; last_sync_at?: string; last_full_check_at?: string; agent_inbox_url?: string }`
  - `export function mirrorManifestPath(dir: string): string`
  - `export function readMirrorManifest(dir: string): MirrorManifest | null`（文件缺失**或 JSON 损坏**都返回 null）
  - `export function isMirrorMode(dir: string): boolean`（**只看文件是否存在**，不解析——清单损坏时绝不能退回经典模式往镜像仓库提交本地改动）

- [ ] **Step 1: 写失败测试**

```ts
// test/mirror.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpDir } from "./helpers.js";
import {
  MIRROR_MANIFEST,
  isMirrorMode,
  readMirrorManifest,
} from "../src/mirror.js";

describe("镜像清单与模式识别", () => {
  it("无清单文件：经典模式，manifest 为 null", () => {
    const dir = tmpDir("mirror");
    expect(isMirrorMode(dir)).toBe(false);
    expect(readMirrorManifest(dir)).toBeNull();
  });

  it("有合法清单：镜像模式，字段可读", () => {
    const dir = tmpDir("mirror");
    fs.writeFileSync(
      path.join(dir, MIRROR_MANIFEST),
      JSON.stringify({
        version: 1,
        last_sync_at: "2026-09-02T10:00:00+08:00",
        agent_inbox_url: "https://x.feishu.cn/wiki/AgentInbox123",
      })
    );
    expect(isMirrorMode(dir)).toBe(true);
    const m = readMirrorManifest(dir);
    expect(m?.last_sync_at).toBe("2026-09-02T10:00:00+08:00");
    expect(m?.agent_inbox_url).toBe("https://x.feishu.cn/wiki/AgentInbox123");
  });

  it("清单损坏：仍是镜像模式（防止误回经典模式上行），但 manifest 为 null", () => {
    const dir = tmpDir("mirror");
    fs.writeFileSync(path.join(dir, MIRROR_MANIFEST), "{ 不是 JSON");
    expect(isMirrorMode(dir)).toBe(true);
    expect(readMirrorManifest(dir)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/mirror.test.ts`
Expected: FAIL（`../src/mirror.js` 模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// src/mirror.ts
import fs from "node:fs";
import path from "node:path";

/**
 * 飞书镜像模式（spec §4）：仓库根存在本清单文件即为镜像仓库。
 * 清单由 exporter 写入并随仓库分发，成员侧只读消费。
 */
export const MIRROR_MANIFEST = ".knowbase-mirror.json";

/** 成员侧消费的清单字段（spec §3.4/§5）；exporter 的其余字段原样保留不管。 */
export interface MirrorManifest {
  version: number;
  /** 最近一次 exporter 成功导出时刻（ISO8601）。 */
  last_sync_at?: string;
  /** 最近一次全量对账时刻（ISO8601）。 */
  last_full_check_at?: string;
  /** 「Agent 沉淀」目录的飞书 wiki URL，注入 agent 提示词（spec §5）。 */
  agent_inbox_url?: string;
}

export function mirrorManifestPath(dir: string): string {
  return path.join(dir, MIRROR_MANIFEST);
}

/**
 * 模式识别只看文件存在与否、刻意不解析内容：清单损坏时若退回经典模式，
 * daemon 会开始把成员的本地改动 commit/push 进镜像仓库——比「暂时读不到
 * 新鲜度」严重得多。损坏只影响 status 的新鲜度展示（spec §4.1）。
 */
export function isMirrorMode(dir: string): boolean {
  return fs.existsSync(mirrorManifestPath(dir));
}

export function readMirrorManifest(dir: string): MirrorManifest | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(mirrorManifestPath(dir), "utf8")
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as MirrorManifest;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/mirror.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/mirror.ts test/mirror.test.ts
git commit -m "feat(mirror): 镜像清单读取与模式识别"
```

---

### Task 2: 只读锁 `setMirrorLock`（spec §4.3 硬防护）

**Files:**
- Modify: `src/mirror.ts`
- Test: `test/mirror.test.ts`（追加 describe）

**Interfaces:**
- Produces: `export function setMirrorLock(dir: string, locked: boolean): number` —— 递归把镜像内 `.md` 文件 chmod 为 0o444（locked）/ 0o644（解锁），返回实际变更的文件数；跳过 `.git`、`skills`、`node_modules`；单个文件失败静默跳过、绝不抛。

- [ ] **Step 1: 写失败测试**（追加到 `test/mirror.test.ts`）

```ts
import { setMirrorLock } from "../src/mirror.js";

describe("setMirrorLock 只读锁", () => {
  function mode(p: string): number {
    return fs.statSync(p).mode & 0o777;
  }

  it("锁定所有 md、返回计数，skills/ 与非 md 文件豁免", () => {
    const dir = tmpDir("lock");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skills", "org-a"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    fs.writeFileSync(path.join(dir, "sub", "b.md"), "b");
    fs.writeFileSync(path.join(dir, "skills", "org-a", "SKILL.md"), "s");
    fs.writeFileSync(path.join(dir, "note.txt"), "t");

    const n = setMirrorLock(dir, true);
    expect(n).toBe(2); // a.md + sub/b.md
    expect(mode(path.join(dir, "a.md"))).toBe(0o444);
    expect(mode(path.join(dir, "sub", "b.md"))).toBe(0o444);
    // skills/ 是 git 原生区（spec §8），保持可写
    expect(mode(path.join(dir, "skills", "org-a", "SKILL.md"))).not.toBe(0o444);
  });

  it("幂等：已锁定的文件第二次不计数；解锁恢复 0o644", () => {
    const dir = tmpDir("lock");
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    expect(setMirrorLock(dir, true)).toBe(1);
    expect(setMirrorLock(dir, true)).toBe(0);
    expect(setMirrorLock(dir, false)).toBe(1);
    expect(mode(path.join(dir, "a.md"))).toBe(0o644);
  });

  it.skipIf(process.platform === "win32")("锁定后直接写文件失败", () => {
    const dir = tmpDir("lock");
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    setMirrorLock(dir, true);
    expect(() => fs.writeFileSync(path.join(dir, "a.md"), "x")).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/mirror.test.ts`
Expected: FAIL（setMirrorLock 未导出）

- [ ] **Step 3: 实现**（追加到 `src/mirror.ts`）

```ts
/**
 * 上锁豁免（spec §4.3）：.git 与 node_modules 显然；skills/ 是 git 原生区
 * （spec §8），由 PR 维护、不来自飞书，不属于镜像内容。
 */
const LOCK_EXEMPT = new Set([".git", "skills", "node_modules"]);

function collectMd(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (LOCK_EXEMPT.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectMd(full, acc);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) acc.push(full);
  }
  return acc;
}

/**
 * 镜像内容只读锁（spec §4.3 硬防护）：agent 的 Edit/Write 当场报权限错误，
 * 失败即引导它回头读 frontmatter 走飞书通道。只锁 .md：其余文件（图片等
 * 附件）没有被 agent 顺手编辑的现实风险，锁面越小越不容易误伤。
 * Windows 上 chmod 映射为 read-only 属性，mode 回读不精确导致幂等判断失效、
 * 每轮全量 chmod——无害，接受。
 */
export function setMirrorLock(dir: string, locked: boolean): number {
  const mode = locked ? 0o444 : 0o644;
  let changed = 0;
  for (const f of collectMd(dir)) {
    try {
      if ((fs.statSync(f).mode & 0o777) === mode) continue;
      fs.chmodSync(f, mode);
      changed++;
    } catch {
      // 单个文件失败（并发删除等）不阻塞其余文件
    }
  }
  return changed;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/mirror.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/mirror.ts test/mirror.test.ts
git commit -m "feat(mirror): 镜像 md 文件只读锁（硬防护）"
```

---

### Task 3: 丢弃本地改动（git 新原语 + `discardLocalChanges`）

**Files:**
- Modify: `src/git.ts`（文件末尾追加两个函数）
- Modify: `src/mirror.ts`
- Test: `test/mirror.test.ts`（追加 describe，用真实 git 仓库）

**Interfaces:**
- Consumes: `git.changedFiles(dir): string[]`、`git.git(args, opts): GitResult`（均已存在于 `src/git.ts`）
- Produces:
  - `src/git.ts`: `export function checkoutAll(dir: string): GitResult`（`git checkout -- .`）
  - `src/git.ts`: `export function cleanUntracked(dir: string, excludes?: string[]): GitResult`（`git clean -fd` + 每个 exclude 一个 `-e`；**无 `-x`**，被 .gitignore 忽略的文件天然不删）
  - `src/mirror.ts`: `export function discardLocalChanges(dir: string): string[]` —— 返回被丢弃的文件相对路径列表（丢弃前用 `changedFiles` 快照）；无改动返回 `[]`，不做任何 git 写操作。

- [ ] **Step 1: 写失败测试**（追加到 `test/mirror.test.ts`）

```ts
import { g, setIdentity, write, read } from "./helpers.js";
import { discardLocalChanges } from "../src/mirror.js";

describe("discardLocalChanges", () => {
  function makeRepo(): string {
    const dir = tmpDir("discard");
    g(dir, "init", "-b", "main", ".");
    setIdentity(dir);
    write(dir, ".gitignore", ".knowbase-pause\n");
    write(dir, "a.md", "原文\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-m", "init");
    return dir;
  }

  it("恢复被改的跟踪文件、删除未跟踪文件，返回文件清单", () => {
    const dir = makeRepo();
    write(dir, "a.md", "被 agent 改坏\n");
    write(dir, "new-dir/rogue.md", "越权新增\n");
    const files = discardLocalChanges(dir);
    expect(files.sort()).toEqual(["a.md", "new-dir/rogue.md"]);
    expect(read(dir, "a.md")).toBe("原文\n");
    expect(fs.existsSync(path.join(dir, "new-dir"))).toBe(false);
  });

  it("暂停标记与被忽略文件不被清掉", () => {
    const dir = makeRepo();
    write(dir, ".knowbase-pause", "");
    write(dir, "b.md", "改动\n"); // 制造一个真实改动触发清理路径
    write(dir, "b2.md", "x\n");
    discardLocalChanges(dir);
    // .knowbase-pause 已被 .gitignore 忽略（clean 无 -x 不删），
    // 且 cleanUntracked 还带 -e 兜底 exporter 忘记种 .gitignore 的情况
    expect(fs.existsSync(path.join(dir, ".knowbase-pause"))).toBe(true);
  });

  it("工作区干净时返回空数组", () => {
    const dir = makeRepo();
    expect(discardLocalChanges(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/mirror.test.ts`
Expected: FAIL（discardLocalChanges 未导出）

- [ ] **Step 3: 实现**

`src/git.ts` 末尾追加：

```ts
/** 丢弃工作区全部已跟踪文件的改动。 */
export function checkoutAll(dir: string): GitResult {
  return git(["checkout", "--", "."], { cwd: dir });
}

/**
 * 删除未跟踪文件与目录。刻意不带 -x：被 .gitignore 忽略的文件
 * （.knowbase-pause 等本机状态）不属于「越权写入的内容」。
 */
export function cleanUntracked(dir: string, excludes: string[] = []): GitResult {
  const args = ["clean", "-fd"];
  for (const e of excludes) args.push("-e", e);
  return git(args, { cwd: dir });
}
```

`src/mirror.ts` 追加（新增 import：`import * as git from "./git.js";` 和 `import { PAUSE_MARKER } from "./config.js";`）：

```ts
/**
 * 丢弃镜像目录内的一切本地改动（spec §4.3 兜底）：镜像目录内不存在合法的
 * 本地修改，正确的修改入口只有飞书，因此直接丢弃、不留底；被丢弃的文件名
 * 由调用方记日志与 status 警告。-e 兜底 exporter 忘记把暂停标记种进
 * .gitignore 的情况——暂停标记是成员本机状态，误删等于静默取消用户的暂停。
 */
export function discardLocalChanges(dir: string): string[] {
  const files = git.changedFiles(dir);
  if (files.length === 0) return [];
  git.checkoutAll(dir);
  git.cleanUntracked(dir, [PAUSE_MARKER]);
  return files;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/mirror.test.ts`
Expected: PASS

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm test` — Expected: 全绿（git.ts 只是追加导出）

```bash
git add src/git.ts src/mirror.ts test/mirror.test.ts
git commit -m "feat(mirror): 本地改动直接丢弃（checkout + clean，保留暂停标记）"
```

---

### Task 4: `mirrorSyncOnce` 镜像同步周期 + daemon 状态

**Files:**
- Modify: `src/sync-engine.ts`（`syncOnce` 顶部分流；新增 `mirrorSyncOnce`；`SyncResult` / `emptyResult` / `runDaemon` 的 `runCycle` 扩展）
- Modify: `src/config.ts`（`DaemonState` 加字段）
- Modify: `src/git.ts`（加 `resetHard`）
- Modify: `test/helpers.ts`（加 `makeMirrorOrigin`）
- Test: `test/mirror-sync.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `isMirrorMode`、Task 2 的 `setMirrorLock`、Task 3 的 `discardLocalChanges`。
- Produces:
  - `SyncResult` 新增字段：`mirror: boolean`（本轮走了镜像路径）、`discardedFiles: string[]`（本轮被丢弃的本地改动）。`emptyResult()` 初始化为 `false` / `[]`。
  - `src/git.ts`: `export function resetHard(dir: string, ref: string): GitResult`（`git reset --hard <ref>`）
  - `src/sync-engine.ts`: `export function mirrorSyncOnce(cfg: Config, deps: SyncDeps): SyncResult`
  - `src/config.ts` `DaemonState` 新增：`mirror?: boolean`、`lastDiscard?: { at: string; files: string[] }`
  - `test/helpers.ts`: `export function makeMirrorOrigin(root: string): string` —— bare 远端 + 已推送的镜像内容（`.knowbase-mirror.json`、`.gitignore` 含 `.knowbase-pause`、`docs/guide.md` 带 frontmatter）。

**镜像周期语义（spec §4.2/§4.3）：** 暂停检查 → 清残留锁 → 全量解锁 → 丢弃本地改动 → fetch → 本地与 `origin/<branch>` 不一致（behind **或** ahead，含有人手动 commit 过）则 `reset --hard origin/<branch>` → finally 无论成败重新上锁。永不 commit、永不 push、不触碰 pushGate。

- [ ] **Step 1: 加测试脚手架**（`test/helpers.ts` 末尾追加）

```ts
/**
 * 搭建：一个 bare 远端 + 已推送镜像内容（.knowbase-mirror.json 在仓库根，
 * 模拟 exporter 的产物）。返回 bare 仓库路径。
 */
export function makeMirrorOrigin(root: string): string {
  const bare = path.join(root, "mirror-origin.git");
  g(root, "init", "--bare", "-b", "main", bare);
  const seed = path.join(root, "mirror-seed");
  g(root, "clone", bare, seed);
  setIdentity(seed);
  fs.writeFileSync(
    path.join(seed, ".knowbase-mirror.json"),
    JSON.stringify(
      {
        version: 1,
        last_sync_at: "2026-09-02T10:00:00+08:00",
        agent_inbox_url: "https://x.feishu.cn/wiki/AgentInbox123",
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(path.join(seed, ".gitignore"), ".knowbase-pause\n");
  fs.mkdirSync(path.join(seed, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(seed, "docs", "guide.md"),
    "---\nfeishu_url: https://x.feishu.cn/wiki/Doc1\n---\n\n# 指南\n"
  );
  g(seed, "add", "-A");
  g(seed, "commit", "-m", "mirror: init");
  g(seed, "push", "origin", "HEAD:main");
  return bare;
}

/** 模拟 exporter 推送一次远端更新：改写文件并 push。 */
export function pushMirrorUpdate(root: string, rel: string, content: string): void {
  const seed = path.join(root, "mirror-seed");
  g(seed, "pull", "origin", "main");
  const full = path.join(seed, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  g(seed, "add", "-A");
  g(seed, "commit", "-m", "mirror: update");
  g(seed, "push", "origin", "HEAD:main");
}
```

- [ ] **Step 2: 写失败测试**

```ts
// test/mirror-sync.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  tmpDir,
  g,
  cloneWorkdir,
  mkConfig,
  makeMirrorOrigin,
  pushMirrorUpdate,
  write,
  read,
} from "./helpers.js";
import { syncOnce } from "../src/sync-engine.js";
import { Logger } from "../src/config.js";

function setup() {
  const root = tmpDir("mirror-sync");
  const bare = makeMirrorOrigin(root);
  const dir = path.join(root, "member");
  cloneWorkdir(bare, dir);
  const cfg = mkConfig(bare, dir);
  const logger = new Logger(path.join(root, "test.log"));
  return { root, bare, dir, cfg, logger };
}

describe("mirrorSyncOnce（经 syncOnce 自动分流）", () => {
  it("识别镜像仓库：不提交、不推送，本地改动被丢弃并上报", () => {
    const { dir, cfg, logger } = setup();
    write(dir, "docs/guide.md", "被本地篡改\n");
    write(dir, "rogue.md", "越权新增\n");
    const r = syncOnce(cfg, { logger });
    expect(r.mirror).toBe(true);
    expect(r.committed).toBe(false);
    expect(r.pushed).toBe(false);
    expect(r.discardedFiles.sort()).toEqual(["docs/guide.md", "rogue.md"]);
    expect(read(dir, "docs/guide.md")).toContain("feishu_url");
    expect(fs.existsSync(path.join(dir, "rogue.md"))).toBe(false);
  });

  it("拉取远端更新，同步后 md 文件为只读", () => {
    const { root, dir, cfg, logger } = setup();
    pushMirrorUpdate(root, "docs/new.md", "---\nfeishu_url: u\n---\n新文档\n");
    const r = syncOnce(cfg, { logger });
    expect(r.mirror).toBe(true);
    expect(r.merged).toBe(true);
    expect(read(dir, "docs/new.md")).toContain("新文档");
    const mode = fs.statSync(path.join(dir, "docs", "new.md")).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o444);
  });

  it("有人手动 commit 过（本地领先/分叉）：reset --hard 到远端，绝不外泄", () => {
    const { dir, cfg, logger } = setup();
    // 手动解锁并伪造一个本地提交
    fs.chmodSync(path.join(dir, "docs", "guide.md"), 0o644);
    write(dir, "docs/guide.md", "手动提交的内容\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-m", "手动越权提交");
    const r = syncOnce(cfg, { logger });
    expect(r.mirror).toBe(true);
    expect(r.pushed).toBe(false);
    expect(read(dir, "docs/guide.md")).toContain("feishu_url");
    // 本地 HEAD 已与远端一致
    const local = g(dir, "rev-parse", "HEAD").stdout.trim();
    const remote = g(dir, "rev-parse", "origin/main").stdout.trim();
    expect(local).toBe(remote);
  });

  it("暂停标记仍然生效", () => {
    const { dir, cfg, logger } = setup();
    write(dir, ".knowbase-pause", "");
    const r = syncOnce(cfg, { logger });
    expect(r.paused).toBe(true);
    expect(r.mirror).toBe(true);
  });

  it("经典仓库（无清单）不受影响：仍走上行路径", () => {
    const root = tmpDir("classic");
    const bare = makeOrigin(root); // makeOrigin 加进文件顶部的 helpers import
    const dir = path.join(root, "member");
    cloneWorkdir(bare, dir);
    write(dir, "note.md", "本地新增\n");
    const r = syncOnce(mkConfig(bare, dir), {
      logger: new Logger(path.join(root, "t.log")),
    });
    expect(r.mirror).toBe(false);
    expect(r.committed).toBe(true);
    expect(r.pushed).toBe(true);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/mirror-sync.test.ts`
Expected: FAIL（`r.mirror` 为 undefined / discardedFiles 不存在）

- [ ] **Step 4: 实现**

`src/git.ts` 追加：

```ts
/** 硬复位到指定 ref（镜像模式远端永远是对的，spec §4.2）。 */
export function resetHard(dir: string, ref: string): GitResult {
  return git(["reset", "--hard", ref], { cwd: dir });
}
```

`src/config.ts` 的 `DaemonState` 追加字段（放在 `pushBlocked?` 之后）：

```ts
  /** 镜像模式（仓库内存在 .knowbase-mirror.json，spec §4.1）。 */
  mirror?: boolean;
  /** 最近一次本地改动被丢弃的记录（镜像模式，spec §4.4）。 */
  lastDiscard?: { at: string; files: string[] };
```

`src/sync-engine.ts`：

1. 顶部 import 追加：`import { isMirrorMode, setMirrorLock, discardLocalChanges } from "./mirror.js";`
2. `SyncResult` 接口追加两个字段（含中文注释），`emptyResult()` 追加 `mirror: false, discardedFiles: [],`：

```ts
  /** 本轮走了镜像模式路径（仓库内存在 .knowbase-mirror.json）。 */
  mirror: boolean;
  /** 镜像模式下本轮被丢弃的本地改动（相对路径）。 */
  discardedFiles: string[];
```

3. `syncOnce` 函数体最顶部（暂停检查之前）加分流：

```ts
  if (isMirrorMode(cfg.dir)) return mirrorSyncOnce(cfg, deps);
```

4. 在 `syncOnce` 之后新增：

```ts
/**
 * 镜像模式的同步周期（spec §4.2/§4.3）：严格单向下行。
 * 永不 commit、永不 push、不触碰 pushGate；本地一切改动直接丢弃（§4.3，
 * 定稿决策：不留底，改动入口只有飞书）；远端永远是对的，本地历史被人
 * 手动动过就 reset --hard。与 syncOnce 同样 never throw。
 */
export function mirrorSyncOnce(cfg: Config, deps: SyncDeps): SyncResult {
  const { logger } = deps;
  const result = emptyResult();
  result.mirror = true;
  const dir = cfg.dir;

  if (isPaused(dir)) {
    result.paused = true;
    logger.log("已暂停（存在 .knowbase-pause），跳过本轮");
    return result;
  }

  try {
    clearStaleLock(dir, logger);
    // 锁是我们自己上的（spec §4.3），操作前先全部解锁，避免 checkout/clean 受阻
    setMirrorLock(dir, false);

    const discarded = discardLocalChanges(dir);
    if (discarded.length > 0) {
      result.discardedFiles = discarded;
      logger.log(
        `镜像目录被本地修改，已丢弃 ${discarded.length} 个文件的改动：${discarded.join(", ")}` +
          `（修改请走飞书文档，见各文件头部 feishu_url）`
      );
    }

    const f = git.fetch(dir, REMOTE);
    if (!git.ok(f)) {
      result.error = `fetch 失败：${f.stderr.trim() || f.stdout.trim()}`;
      logger.log(result.error + "（下一周期重试）");
      return result;
    }

    const upstream = `${REMOTE}/${cfg.branch}`;
    if (
      git.upstreamExists(dir, upstream) &&
      (git.behindCount(dir, upstream) > 0 || git.aheadCount(dir, upstream) > 0)
    ) {
      // behind：正常跟进。ahead/分叉：有人绕过锁手动 commit 过——镜像仓库的
      // 本地历史没有保留价值，硬复位即「丢弃改动」在提交层面的同一原则。
      const r = git.resetHard(dir, upstream);
      if (git.ok(r)) {
        result.merged = true;
      } else {
        result.error = `reset 失败：${(r.stderr || r.stdout).trim()}`;
        logger.log(result.error + "（下一周期重试）");
      }
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    logger.log(`镜像同步周期异常：${result.error}`);
  } finally {
    // 无论成败都恢复上锁：解锁窗口越短，agent 撞进来的概率越低
    try {
      setMirrorLock(dir, true);
    } catch {
      // never throw
    }
  }
  return result;
}
```

5. `runDaemon` 的 `runCycle` 内，`state.pushBlocked = gate.snapshot();` 之前追加：

```ts
      state.mirror = r.mirror || undefined;
      if (r.discardedFiles.length > 0) {
        state.lastDiscard = { at: state.lastCycleAt!, files: r.discardedFiles };
      }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/mirror-sync.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 6: 全量回归 + 提交**

Run: `npm test && npm run build` — Expected: 全绿、编译通过（经典模式用例不受分流影响）

```bash
git add src/sync-engine.ts src/config.ts src/git.ts src/mirror.ts test/helpers.ts test/mirror-sync.test.ts
git commit -m "feat(mirror): 镜像同步周期——单向下行、丢弃本地改动、reset --hard 跟随远端"
```

---

### Task 5: prompt 区块镜像文案（spec §5）

**Files:**
- Modify: `src/agent-config.ts`（`buildBlock` 加第三参；`syncAgentConfig` 自动检测镜像）
- Test: `test/agent-config.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `isMirrorMode`、`readMirrorManifest`。
- Produces:
  - `export interface MirrorBlockInfo { inboxUrl?: string }`
  - `buildBlock(dir: string, index?: string | null, mirror?: MirrorBlockInfo | null): string` —— 第三参为 null/undefined 时输出与现状完全相同（经典文案）。
  - `syncAgentConfig` 签名不变，内部自动检测：镜像仓库时以 `{ inboxUrl: manifest?.agent_inbox_url }` 调 `buildBlock`。

- [ ] **Step 1: 写失败测试**（追加到 `test/agent-config.test.ts`；沿用该文件已有的 import 风格）

```ts
import { buildBlock } from "../src/agent-config.js";

describe("镜像模式区块文案", () => {
  it("镜像变体：只读声明 + feishu_url 引导 + 沉淀目录 URL", () => {
    const block = buildBlock("/kb", null, {
      inboxUrl: "https://x.feishu.cn/wiki/AgentInbox123",
    });
    expect(block).toContain("只读本地镜像");
    expect(block).toContain("feishu_url");
    expect(block).toContain("lark-doc");
    expect(block).toContain("https://x.feishu.cn/wiki/AgentInbox123");
    // 经典文案的「保存即同步」不得出现——那句话在镜像模式下是错误引导
    expect(block).not.toContain("保存即同步");
  });

  it("无沉淀目录 URL：提示询问用户", () => {
    const block = buildBlock("/kb", null, {});
    expect(block).toContain("询问用户");
  });

  it("第三参缺省：输出与经典文案逐字一致", () => {
    expect(buildBlock("/kb", "索引内容")).toBe(buildBlock("/kb", "索引内容", null));
    expect(buildBlock("/kb", "索引内容")).toContain("保存即同步");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/agent-config.test.ts`
Expected: FAIL（buildBlock 不接受第三参 / 文案缺失）

- [ ] **Step 3: 实现**

`src/agent-config.ts`：顶部 import 追加 `import { isMirrorMode, readMirrorManifest } from "./mirror.js";`，然后：

```ts
/** 镜像模式注入区块所需信息（spec §5）。 */
export interface MirrorBlockInfo {
  /** 「Agent 沉淀」目录的飞书 wiki URL；exporter 侧未配置时缺失。 */
  inboxUrl?: string;
}
```

`buildBlock` 改为：

```ts
export function buildBlock(
  dir: string,
  index?: string | null,
  mirror?: MirrorBlockInfo | null
): string {
  const hasIndex = index != null && index.trim() !== "";
  const indexSection = hasIndex
    ? `### 知识库索引（根 ${INDEX_NAME} 快照，由 knowbase 自动同步）

${index}`
    : `根目录暂无 \`${INDEX_NAME}\`，需要时直接 grep 全库。`;

  if (mirror) {
    const inbox = mirror.inboxUrl
      ? `：${mirror.inboxUrl}`
      : "（沉淀目录 URL 未配置，请询问用户）";
    return `${BLOCK_START}
## 组织知识库（knowbase · 飞书镜像）

\`${dir}\` —— 飞书知识库的**只读本地镜像**，全组织共享，后台自动从飞书单向同步。

**读**：需要业务背景、历史决策、架构约定、环境配置、踩坑记录等组织隐性知识时，先 grep / 读该目录下的 Markdown。

**写（重要，本目录只读）**：
- 禁止直接编辑本目录任何文件——文件已设只读，写入会失败；绕过锁写入的内容也会在下个同步周期被自动丢弃。
- 要修改某篇知识：取该文件头部 frontmatter 的 \`feishu_url\`，用飞书文档工具（lark-doc）编辑对应飞书文档。
- 编辑前先用 lark-doc 读取该文档的最新内容——本地镜像可能落后几分钟，不要基于旧版整篇覆盖。
- 要新增知识：用 lark-wiki 在「Agent 沉淀」目录下创建文档${inbox}。
- 修改会在几分钟内自动回流到本目录；同一会话内如需引用刚写入的内容，以写进飞书的版本为准。

**团队 skill**：\`${SKILLS_SUBDIR}/\` 目录不走飞书，通过知识库 git 仓库提 PR 维护（需含 \`name\` / \`description\` frontmatter），knowbase 自动分发到全团队，本机以 \`${ORG_PREFIX}<name>\` 出现。

**导航**：每个目录下的 \`${INDEX_NAME}\` 是该目录索引（文件名大小写不敏感）。进子目录前先读它。

${indexSection}
${BLOCK_END}`;
  }

  // ……以下为原有经典文案 return，保持逐字不动……
}
```

`syncAgentConfig` 中 `const block = buildBlock(dir, readIndex(dir).text);` 改为：

```ts
  // 镜像仓库自动切换文案（spec §5）；清单损坏时 manifest 为 null，
  // 仍走镜像文案（只是没有沉淀目录 URL）——见 isMirrorMode 的注释
  const mirror = isMirrorMode(dir)
    ? { inboxUrl: readMirrorManifest(dir)?.agent_inbox_url }
    : null;
  const block = buildBlock(dir, readIndex(dir).text, mirror);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/agent-config.test.ts`
Expected: PASS（新增 3 个 + 原有用例全绿）

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm test` — Expected: 全绿

```bash
git add src/agent-config.ts test/agent-config.test.ts
git commit -m "feat(mirror): agent 提示词镜像变体——读本地、写飞书、编辑前先读最新版"
```

---

### Task 6: status 镜像段（spec §4.4）

**Files:**
- Modify: `src/mirror.ts`（新鲜度纯函数）
- Modify: `src/commands/status.ts`
- Test: `test/mirror.test.ts`（追加 describe，只测纯函数）

**Interfaces:**
- Produces:
  - `export const MIRROR_STALE_MS = 30 * 60 * 1000`（spec §4.4 阈值）
  - `export interface MirrorFreshness { unreadable: boolean; lastSyncAt: string | null; lastFullCheckAt: string | null; stale: boolean }`
  - `export function mirrorFreshness(manifest: MirrorManifest | null, now: Date): MirrorFreshness` —— manifest 为 null 时 `unreadable: true, stale: true`；`last_sync_at` 缺失或距 now 超过阈值时 `stale: true`。

- [ ] **Step 1: 写失败测试**（追加到 `test/mirror.test.ts`）

```ts
import { mirrorFreshness, MIRROR_STALE_MS } from "../src/mirror.js";

describe("mirrorFreshness", () => {
  const now = new Date("2026-09-02T12:00:00+08:00");

  it("30 分钟内为 fresh", () => {
    const f = mirrorFreshness(
      { version: 1, last_sync_at: "2026-09-02T11:45:00+08:00" },
      now
    );
    expect(f.stale).toBe(false);
    expect(f.unreadable).toBe(false);
  });

  it("超过 30 分钟为 stale", () => {
    const f = mirrorFreshness(
      { version: 1, last_sync_at: "2026-09-02T11:00:00+08:00" },
      now
    );
    expect(f.stale).toBe(true);
  });

  it("manifest 为 null（损坏/缺失）：unreadable 且 stale", () => {
    const f = mirrorFreshness(null, now);
    expect(f.unreadable).toBe(true);
    expect(f.stale).toBe(true);
  });

  it("last_sync_at 缺失或非法时间：stale", () => {
    expect(mirrorFreshness({ version: 1 }, now).stale).toBe(true);
    expect(
      mirrorFreshness({ version: 1, last_sync_at: "不是时间" }, now).stale
    ).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/mirror.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**（追加到 `src/mirror.ts`）

```ts
/** exporter 停摆判定阈值（spec §4.4）：导出周期 2 分钟，30 分钟未更新即异常。 */
export const MIRROR_STALE_MS = 30 * 60 * 1000;

export interface MirrorFreshness {
  /** 清单缺失或损坏（isMirrorMode 为 true 但读不出内容）。 */
  unreadable: boolean;
  lastSyncAt: string | null;
  lastFullCheckAt: string | null;
  /** exporter 疑似停摆：last_sync_at 缺失、非法或超过阈值。 */
  stale: boolean;
}

export function mirrorFreshness(
  manifest: MirrorManifest | null,
  now: Date
): MirrorFreshness {
  if (!manifest) {
    return { unreadable: true, lastSyncAt: null, lastFullCheckAt: null, stale: true };
  }
  const lastSyncAt = manifest.last_sync_at ?? null;
  const t = lastSyncAt ? Date.parse(lastSyncAt) : NaN;
  const stale = !Number.isFinite(t) || now.getTime() - t > MIRROR_STALE_MS;
  return {
    unreadable: false,
    lastSyncAt,
    lastFullCheckAt: manifest.last_full_check_at ?? null,
    stale,
  };
}
```

`src/commands/status.ts` 改动（wiring，靠 Step 5 全量回归 + 人工跑一次验证）：

1. import 追加：`import { isMirrorMode, readMirrorManifest, mirrorFreshness } from "../mirror.js";`
2. `const cfg = loadConfig();` 之后：`const mirrorMode = isMirrorMode(cfg.dir);`
3. 「远端仓库」那行 console.log 之后追加：

```ts
  if (mirrorMode) {
    console.log("模式：      飞书镜像（只读，真相源在飞书知识库）");
  }
```

4. 守护进程段末尾（`state?.lastError` 打印之后）追加：

```ts
  if (mirrorMode) {
    const fresh = mirrorFreshness(readMirrorManifest(cfg.dir), new Date());
    if (fresh.unreadable) {
      console.log("镜像清单：  ✗ .knowbase-mirror.json 无法解析");
      anomalies.push("镜像清单损坏——exporter 侧可能异常，请联系知识库管理员。");
    } else {
      console.log(`镜像更新：  ${fmtTime(fresh.lastSyncAt ?? undefined)}`);
      console.log(`全量对账：  ${fmtTime(fresh.lastFullCheckAt ?? undefined)}`);
      if (fresh.stale) {
        anomalies.push(
          "镜像已超过 30 分钟未更新——exporter 可能停摆（本地内容仍可读），请联系知识库管理员。"
        );
      }
    }
    if (state?.lastDiscard) {
      const d = state.lastDiscard;
      const head = d.files.slice(0, 5).join(", ");
      console.log(
        `本地改动丢弃：${fmtTime(d.at)}，${d.files.length} 个文件（${head}${d.files.length > 5 ? " …" : ""}）——镜像只读，修改请走飞书`
      );
    }
  }
```

5. 「本地待推送」两行（`console.log("");` 起到 `本地领先远端` 行止）与整个 pushBlocked 段包进 `if (!mirrorMode) { … }`：镜像模式下这些口径没有意义且会误导。注意 `uncommitted`/`ahead` 变量声明保留在块外（pushBlocked 段引用了 `ahead`），只是打印与 pushBlocked 逻辑进块。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/mirror.test.ts`
Expected: PASS

- [ ] **Step 5: 全量回归 + 手动冒烟 + 提交**

Run: `npm test && npm run build` — Expected: 全绿。
手动冒烟（可选但推荐）：用 Task 4 的 `makeMirrorOrigin` 场景手动 clone 一个镜像仓库、把配置指过去跑 `node dist/cli.js status`，确认镜像段输出与 stale 异常出现。

```bash
git add src/mirror.ts src/commands/status.ts test/mirror.test.ts
git commit -m "feat(mirror): status 展示镜像新鲜度与丢弃警告，隐藏无意义的推送口径"
```

---

### Task 7: uninstall 解锁 + README 文档 + 收尾回归

**Files:**
- Modify: `src/commands/uninstall.ts`
- Modify: `README.md`（追加「飞书镜像模式」章节）

**Interfaces:**
- Consumes: Task 1 的 `isMirrorMode`、Task 2 的 `setMirrorLock`。

- [ ] **Step 1: uninstall 解锁**

`src/commands/uninstall.ts`：import 追加 `import { isMirrorMode, setMirrorLock } from "../mirror.js";`，在 `clearDaemonState();` 之后追加：

```ts
  // 镜像模式下把上锁的文件恢复可写：uninstall 保留本地文件夹（product.md 非目标），
  // 留一堆 444 文件会让用户之后整理自己的目录时莫名其妙
  if (dir && isMirrorMode(dir)) {
    try {
      const n = setMirrorLock(dir, false);
      if (n > 0) console.log(`• 已解除镜像只读锁（${n} 个文件恢复可写）`);
    } catch (e) {
      console.warn(
        `⚠ 解除只读锁时出错：${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
```

- [ ] **Step 2: 补一个回归用例**（追加到 `test/mirror.test.ts`；uninstall 全流程有自启副作用不好测，只测锁的可逆性已在 Task 2 覆盖，这里补「解锁后文件可写」的端到端断言）

```ts
it.skipIf(process.platform === "win32")("解锁后文件恢复可写（uninstall 路径依赖）", () => {
  const dir = tmpDir("unlock");
  fs.writeFileSync(path.join(dir, "a.md"), "a");
  setMirrorLock(dir, true);
  setMirrorLock(dir, false);
  expect(() => fs.writeFileSync(path.join(dir, "a.md"), "可以写了")).not.toThrow();
});
```

- [ ] **Step 3: README 追加章节**（放在现有「工作原理」类章节之后，标题级别与全文一致）

内容要点（用 README 现有口吻展开成 15–25 行）：

```markdown
## 飞书镜像模式

当知识库以飞书知识库为唯一真相源时（仓库由服务器上的 exporter 从飞书单向导出，
仓库根带有 `.knowbase-mirror.json`），成员侧 knowbase 自动进入镜像模式，无需任何配置：

- 本地目录是只读镜像：md 文件被设为只读；任何本地改动会在下个同步周期被直接丢弃
  （status 会给出警告）。修改知识请打开对应文件头部 frontmatter 里的 `feishu_url`
  去飞书编辑；新增知识写到飞书知识库的「Agent 沉淀」目录。
- agent 提示词区块自动切换为镜像版引导：读走本地 grep，写走飞书文档工具。
- `skills/` 目录不走飞书：它是 git 原生区，通过仓库 PR 维护，照常自动分发。
- `knowbase status` 额外显示镜像更新时间与全量对账时间；超过 30 分钟未更新会提示
  exporter 可能停摆。
- 权限注意：飞书侧的细粒度可见性不会带进镜像——能 clone 仓库的人可见全部导出内容，
  请只镜像对团队全员开放的 space（详见 docs/superpowers/specs/2026-09-02-lark-mirror-mode-design.md §10）。

exporter 与一次性迁移工具（`knowbase exporter` / `knowbase migrate-to-lark`）见后续版本。
```

- [ ] **Step 4: 全量回归**

Run: `npm test && npm run build` — Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/commands/uninstall.ts test/mirror.test.ts README.md
git commit -m "feat(mirror): uninstall 解除只读锁；README 补镜像模式说明"
```

---

## 计划外（后续独立计划）

- 计划 ②：`knowbase exporter`（飞书 client、docx→md 转换、节点树 diff、git 发布、Docker/systemd）——spec §3。
- 计划 ③：`knowbase migrate-to-lark` 一次性迁移——spec §7。
- 本计划的镜像清单字段即两者的契约：exporter 必须写 `version` / `last_sync_at` / `last_full_check_at` / `agent_inbox_url`（snake_case）。
