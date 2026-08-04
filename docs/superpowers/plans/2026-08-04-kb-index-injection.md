# 知识库索引自动注入 agent 提示词 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把知识库根 `index.md` 全文内嵌进 Claude Code / Codex 全局提示词的 knowbase 托管区块，并由守护进程每个同步周期自动刷新，让 agent 无需被提示就知道知识库里有什么。

**Architecture:** 复用已有的 Markdown 托管区块机制（`<!-- KNOWBASE:START -->` … `<!-- KNOWBASE:END -->`）。`agent-config.ts` 新增索引读取（大小写不敏感定位 + 标记中和 + 8KB 截断），`buildBlock` 接受索引正文并内嵌；`installAgentConfig` 改名 `syncAgentConfig` 并改为原子写入、内容未变不落盘；`sync-engine.ts` 的 `runCycle` 末尾调用刷新。不引入 hook、不做 JSON 配置合并、不生成索引内容。

**Tech Stack:** TypeScript（ESM，`tsc` → `dist/`）、Node ≥ 18、vitest。零新增依赖。

**规格来源：** [2026-08-04-kb-index-injection-design.md](../specs/2026-08-04-kb-index-injection-design.md)

## Global Constraints

- **零新增依赖**：只允许用 Node 内置模块（`node:fs` / `node:path` / `node:os`）。现有依赖仅 `commander` + `update-notifier`。
- **索引文件名大小写不敏感**：`index.md` / `Index.md` / `INDEX.md` 均识别；并存时优先精确 `index.md`，否则取排序首个。
- **索引字节上限 `INDEX_MAX_BYTES = 8192`**，超限在行边界截断并附提示。
- **守护进程永不崩溃**：刷新逻辑的任何异常只记日志，不得影响 `SyncResult` / `DaemonState`，不得让进程退出。
- **代码注释与用户可见输出全部用简体中文**，与现有代码风格一致。
- **e2e 测试（`test/cli.test.ts`、`test/daemon-watch.test.ts`）跑的是 `dist/cli.js`**，改动源码后必须先 `npm run build` 再 `npm test`。
- 不生成、不播种 `index.md`；不注入子目录索引。

---

## File Structure

| 文件 | 责任 | 本计划中的改动 |
|---|---|---|
| `src/agent-config.ts` | 托管区块的构造、读写、幂等 upsert/strip；索引读取与规范化 | 新增 `pickIndexName` / `neutralizeMarkers` / `readIndex` / `writeFileAtomic`；`buildBlock` 增参；`installAgentConfig` → `syncAgentConfig` |
| `src/config.ts` | 路径约定、config 读写、日志 | `Config` 增 `agentConfig?: boolean` |
| `src/commands/init.ts` | 一次性接入流程 | 持久化 `agentConfig`；调用改名后的函数 |
| `src/sync-engine.ts` | 同步周期与守护循环 | 新增 `refreshAgentPrompts`，在 `runCycle` 末尾调用 |
| `src/commands/status.ts` | 健康度汇总 | 新增「agent 提示词」一行 |
| `test/agent-config.test.ts` | 区块与索引的单元测试 | 新增两个 describe |
| `test/cli.test.ts` | CLI e2e | 新增 `agentConfig` 持久化与索引注入用例 |
| `test/daemon-watch.test.ts` | 守护进程 e2e | 新增索引变更后自动刷新用例 |
| `test/sync-engine.test.ts` | 引擎单元测试 | 新增 `refreshAgentPrompts` 的开关与容错用例 |

---

### Task 1: 索引读取（定位 + 中和 + 截断）

只做纯逻辑，不接线到区块。

**Files:**
- Modify: `src/agent-config.ts`（在 `buildBlock` 之前插入）
- Test: `test/agent-config.test.ts`

**Interfaces:**
- Consumes: 无（本任务是起点）
- Produces:
  - `INDEX_NAME: string`（值 `"index.md"`）
  - `INDEX_MAX_BYTES: number`（值 `8192`）
  - `pickIndexName(entries: string[]): string | null`
  - `neutralizeMarkers(text: string): string`
  - `interface IndexResult { name: string | null; text: string | null; bytes: number; truncated: boolean }`
  - `readIndex(dir: string): IndexResult`

- [ ] **Step 1: 写失败的测试**

在 `test/agent-config.test.ts` 的 import 块中把 `installAgentConfig` 之外的导入补齐（本任务只需新增这几个名字）：

```typescript
import {
  BLOCK_START,
  BLOCK_END,
  buildBlock,
  upsertBlock,
  stripBlock,
  installAgentConfig,
  uninstallAgentConfig,
  agentTargets,
  pickIndexName,
  readIndex,
  INDEX_MAX_BYTES,
} from "../src/agent-config.js";
```

在文件末尾追加：

```typescript
describe("索引读取", () => {
  let kb: string;
  beforeEach(() => {
    kb = tmpDir("kb");
  });
  afterEach(() => {
    fs.rmSync(kb, { recursive: true, force: true });
  });

  it("pickIndexName 大小写不敏感", () => {
    expect(pickIndexName(["README.md", "Index.md"])).toBe("Index.md");
    expect(pickIndexName(["INDEX.MD"])).toBe("INDEX.MD");
    expect(pickIndexName(["readme.md", "角色"])).toBe(null);
    expect(pickIndexName([])).toBe(null);
  });

  it("pickIndexName 并存变体时取值确定：优先精确小写", () => {
    // 并存状态只可能出现在大小写敏感的文件系统上，无法在 macOS 落盘构造，
    // 因此选取逻辑写成纯函数，直接喂条目名数组来测。
    expect(pickIndexName(["Index.md", "index.md", "INDEX.md"])).toBe("index.md");
    // 无精确匹配 → 排序首个（'N' < 'n'，故 INDEX.md 在前）
    expect(pickIndexName(["Index.md", "INDEX.md"])).toBe("INDEX.md");
  });

  it("索引缺失 → 全部为空且不抛错", () => {
    const r = readIndex(kb);
    expect(r.name).toBe(null);
    expect(r.text).toBe(null);
    expect(r.bytes).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("目录不存在 → 不抛错", () => {
    const r = readIndex(path.join(kb, "nope"));
    expect(r.name).toBe(null);
  });

  it("读取 Index.md 并中和标记字样", () => {
    fs.writeFileSync(
      path.join(kb, "Index.md"),
      "# 索引\n- knowbase 的区块以 KNOWBASE:END 结尾\n"
    );
    const r = readIndex(kb);
    expect(r.name).toBe("Index.md");
    expect(r.text).toContain("# 索引");
    expect(r.text).not.toContain("KNOWBASE:END");
    expect(r.text).toContain("KNOWBASE_END");
    expect(r.truncated).toBe(false);
  });

  it("超 8KB → 行边界截断并附提示", () => {
    const line = "x".repeat(99) + "\n"; // 100 字节/行
    fs.writeFileSync(path.join(kb, "index.md"), line.repeat(100)); // 10000 字节
    const r = readIndex(kb);
    expect(r.bytes).toBe(10000);
    expect(r.truncated).toBe(true);
    expect(r.text!).toContain("已截断");
    // 正文部分（提示前）必须整行完整，且不超上限
    const body = r.text!.split("\n\n…")[0];
    expect(body.split("\n").every((l) => l === "x".repeat(99))).toBe(true);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(INDEX_MAX_BYTES);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/agent-config.test.ts -t "索引读取"
```

预期：FAIL，报 `pickIndexName is not a function` / `readIndex is not a function`（TS 编译期即报「不存在导出成员」）。

- [ ] **Step 3: 实现**

在 `src/agent-config.ts` 中，`buildBlock` 定义之前插入：

```typescript
/** 索引文件的规范名。查找时大小写不敏感。 */
export const INDEX_NAME = "index.md";

/** 内嵌索引的字节上限（约 2k token）。索引长起来会静默吃掉每次会话的上下文预算。 */
export const INDEX_MAX_BYTES = 8192;

/**
 * 从目录条目名中挑出索引文件名，大小写不敏感。
 *
 * APFS 默认大小写不敏感、Linux 敏感：按字面 index.md 查找会导致仓库里存在
 * Index.md 时「macOS 上索引生效、Linux 上索引缺失」的跨平台不一致。
 *
 * 写成接受条目名数组的纯函数，是因为「多个大小写变体并存」在大小写不敏感的
 * 文件系统上无法落盘构造，只能这样测。
 */
export function pickIndexName(entries: string[]): string | null {
  const matches = entries.filter((e) => e.toLowerCase() === INDEX_NAME);
  if (matches.length === 0) return null;
  if (matches.includes(INDEX_NAME)) return INDEX_NAME;
  return [...matches].sort()[0];
}

/**
 * 中和索引正文中的区块标记字样。
 *
 * 索引由外部 agent 生成，正文里完全可能出现 KNOWBASE:END（例如索引记录了
 * knowbase 自身的文档）。若原样内嵌，upsertBlock / stripBlock 会匹配到提前
 * 出现的结束标记、切错位置，吞掉用户 CLAUDE.md 中区块之后的内容。
 */
export function neutralizeMarkers(text: string): string {
  return text.replace(/KNOWBASE:(START|END)/g, "KNOWBASE_$1");
}

/** 按字节上限截断，切点落在不超限的最后一个换行处。 */
function truncateAtLine(text: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, truncated: false };
  const head = buf.subarray(0, max).toString("utf8");
  const cut = head.lastIndexOf("\n");
  // 无换行可切（单行超长）时退化为按字符切，并去掉多字节字符被切断产生的替换符
  const kept = cut > 0 ? head.slice(0, cut) : head.replace(/�+$/, "");
  return { text: kept, truncated: true };
}

export interface IndexResult {
  /** 实际命中的文件名（如 index.md / Index.md）；未找到为 null。 */
  name: string | null;
  /** 规范化后可直接内嵌的正文；未找到为 null。 */
  text: string | null;
  /** 索引文件原始字节数（供 status 展示）。 */
  bytes: number;
  /** 是否因超过 INDEX_MAX_BYTES 被截断。 */
  truncated: boolean;
}

const EMPTY_INDEX: IndexResult = { name: null, text: null, bytes: 0, truncated: false };

/**
 * 读取知识库根索引并规范化为可内嵌的正文。
 * 目录不存在 / 无索引 / 读取失败一律返回空结果，绝不抛错——
 * 索引维护 agent 尚未跑起来时 init 不该失败。
 */
export function readIndex(dir: string): IndexResult {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return EMPTY_INDEX;
  }
  const name = pickIndexName(entries);
  if (!name) return EMPTY_INDEX;

  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, name), "utf8");
  } catch {
    return EMPTY_INDEX;
  }

  const bytes = Buffer.byteLength(raw, "utf8");
  const cut = truncateAtLine(neutralizeMarkers(raw), INDEX_MAX_BYTES);
  const text = cut.truncated
    ? `${cut.text}\n\n…（索引过长已截断，完整内容见 \`${path.join(dir, name)}\`）`
    : cut.text;
  return { name, text, bytes, truncated: cut.truncated };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run test/agent-config.test.ts
```

预期：PASS，含新增的 6 个用例，且原有区块用例全部不受影响。

- [ ] **Step 5: 提交**

```bash
git add src/agent-config.ts test/agent-config.test.ts
git commit -m "feat(agent-config): 索引读取（大小写不敏感定位、标记中和、8KB 行边界截断）"
```

---

### Task 2: 区块内嵌索引 + 原子写入 + 未变不落盘

**Files:**
- Modify: `src/agent-config.ts`（`buildBlock`、`installAgentConfig`）
- Modify: `src/commands/init.ts:14`（import）与 `src/commands/init.ts:175`（调用点）
- Test: `test/agent-config.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `readIndex(dir): IndexResult`、`INDEX_NAME`
- Produces:
  - `buildBlock(dir: string, index?: string | null): string`（第二参为已规范化的索引正文）
  - `syncAgentConfig(dir: string, home?: string): AgentConfigChange[]`（替代 `installAgentConfig`，同签名同返回类型）

- [ ] **Step 1: 写失败的测试**

在 `test/agent-config.test.ts` 的 import 中，把 `installAgentConfig` 替换为 `syncAgentConfig`，并把已有 describe `"installAgentConfig / uninstallAgentConfig"` 里的 3 处 `installAgentConfig(` 调用改成 `syncAgentConfig(`（第 73、89 行附近；describe 标题同步改为 `"syncAgentConfig / uninstallAgentConfig"`）。

然后在文件末尾追加：

```typescript
describe("区块内嵌索引", () => {
  let kb: string;
  beforeEach(() => {
    kb = tmpDir("kb");
  });
  afterEach(() => {
    fs.rmSync(kb, { recursive: true, force: true });
  });

  const claudeFile = () => path.join(home, ".claude", "CLAUDE.md");

  it("有索引 → 含索引标题、正文与导航段", () => {
    const b = buildBlock("/kb", "# 索引\n- 角色/：角色定义与职责");
    expect(b).toContain("### 知识库索引");
    expect(b).toContain("角色定义与职责");
    expect(b).toContain("**导航**");
  });

  it("无索引 → 回退文案、无索引标题、仍有导航段", () => {
    const b = buildBlock("/kb", null);
    expect(b).not.toContain("### 知识库索引");
    expect(b).toContain("暂无");
    expect(b).toContain("**导航**");
  });

  it("索引含标记字样时 sync→strip 往返不吞用户内容", () => {
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n区块以 KNOWBASE:END 收尾\n");
    fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
    fs.writeFileSync(claudeFile(), "# 偏好\n用中文回答\n");

    syncAgentConfig(kb, home);
    const { content, removed } = stripBlock(fs.readFileSync(claudeFile(), "utf8"));
    expect(removed).toBe(true);
    expect(content).toContain("用中文回答");
    expect(content).not.toContain("KNOWBASE");
  });

  it("内容未变 → unchanged 且不落盘", async () => {
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n- 条目\n");
    syncAgentConfig(kb, home);
    const before = fs.statSync(claudeFile()).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));

    const again = syncAgentConfig(kb, home);
    expect(again.every((c) => c.action === "unchanged")).toBe(true);
    expect(fs.statSync(claudeFile()).mtimeMs).toBe(before);
  });

  it("索引变化 → 区块随之更新，旧内容消失", () => {
    const idx = path.join(kb, "index.md");
    fs.writeFileSync(idx, "# 索引\n- 旧条目\n");
    syncAgentConfig(kb, home);

    fs.writeFileSync(idx, "# 索引\n- 新条目\n");
    const changes = syncAgentConfig(kb, home);
    expect(changes.every((c) => c.action === "updated")).toBe(true);

    const content = fs.readFileSync(claudeFile(), "utf8");
    expect(content).toContain("新条目");
    expect(content).not.toContain("旧条目");
  });

  it("写入后不残留临时文件", () => {
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n");
    syncAgentConfig(kb, home);
    const left = fs.readdirSync(path.join(home, ".claude"));
    expect(left.some((f) => f.includes("knowbase-tmp"))).toBe(false);
    expect(left).toContain("CLAUDE.md");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/agent-config.test.ts
```

预期：FAIL，报 `syncAgentConfig` 不存在，且 `buildBlock("/kb", null)` 的断言（`**导航**`、`暂无`）不成立。

- [ ] **Step 3: 实现**

3a. 把 `src/agent-config.ts` 的 `buildBlock` 整体替换为：

```typescript
/**
 * 生成托管区块正文（含起止标记），内嵌本机知识库目录与根索引快照。
 * index 传 null / undefined 时输出回退文案（索引维护 agent 还没跑起来的情况）。
 */
export function buildBlock(dir: string, index?: string | null): string {
  const indexSection = index
    ? `### 知识库索引（根 ${INDEX_NAME} 快照，由 knowbase 自动同步）

${index}`
    : `根目录暂无 \`${INDEX_NAME}\`，需要时直接 grep 全库。`;

  return `${BLOCK_START}
## 组织知识库（knowbase）

本机知识库位于：\`${dir}\`
这是**全组织共享**的知识库：一个由 knowbase 后台自动与 Git 远端双向同步的文件夹，你写入的任何内容都会同步给团队所有成员。

**读**：需要组织的业务背景、历史决策、架构约定、环境配置、踩坑记录等隐性知识时，优先 grep / 读取该目录下的 Markdown。

**写**：只沉淀「对团队其他成员有复用价值」的组织级知识，写入前先自问：换一个同事看到这条，是否有用？
- ✅ 该写入：业务规则与背景、技术决策及其原因、公共环境/服务配置、通用踩坑与解决方案、跨项目约定。
- ❌ 禁止写入：用户的个人偏好与习惯、个人待办/日程/草稿、只与当前这台机器或当前个人任务相关的内容、任何私人信息（姓名/账号/密钥/个人路径等）。这类内容应放在本机的个人配置（如 \`~/.claude/CLAUDE.md\`）或个人笔记里，绝不进入知识库。
- 拿不准是否属于组织知识时，先询问用户，不要擅自写入。

**操作**：直接在该目录写入 / 编辑 Markdown 即可，保存即同步，无需 git add/commit/push。大范围改动前先运行 \`knowbase pause\`，完成后 \`knowbase resume\`。

**导航**：知识库每个目录下都有 \`${INDEX_NAME}\` 作为该目录的索引（文件名大小写不敏感）。进入任一子目录查找前，先读该目录的 \`${INDEX_NAME}\`；在知识库中新增或删除文件后，顺手更新所在目录的 \`${INDEX_NAME}\`。

${indexSection}
${BLOCK_END}`;
}
```

3b. 在 `installAgentConfig` 之前插入原子写入辅助：

```typescript
/**
 * 原子写入：同目录临时文件 + rename。
 * 这些是用户的个人提示词文件，改为每个同步周期都可能触发的周期性写入后，
 * 进程在错误时机被 kill 会留下截断的 CLAUDE.md，损坏代价高。
 */
function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.knowbase-tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}
```

3c. 把 `installAgentConfig` 整体替换为 `syncAgentConfig`（改名 + 读索引 + 原子写）：

```typescript
/**
 * 把托管区块（含知识库根索引快照）写入所有 agent 全局提示词文件。
 * init 与守护进程每个同步周期共用此函数；内容与现状相同则不落盘。
 */
export function syncAgentConfig(
  dir: string,
  home: string = os.homedir()
): AgentConfigChange[] {
  const block = buildBlock(dir, readIndex(dir).text);
  const changes: AgentConfigChange[] = [];
  for (const t of agentTargets(home)) {
    const existed = fs.existsSync(t.file);
    const prev = existed ? fs.readFileSync(t.file, "utf8") : "";
    const next = upsertBlock(prev, block);
    if (next === prev) {
      changes.push({ name: t.name, file: t.file, action: "unchanged" });
      continue;
    }
    writeFileAtomic(t.file, next);
    changes.push({
      name: t.name,
      file: t.file,
      action: existed ? "updated" : "created",
    });
  }
  return changes;
}
```

3d. `src/commands/init.ts` 第 14 行 import 改为：

```typescript
import { syncAgentConfig } from "../agent-config.js";
```

3e. `src/commands/init.ts` 第 175 行调用改为：

```typescript
      const changes = syncAgentConfig(dir);
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run build && npm test
```

预期：全部 PASS。`test/cli.test.ts`、`test/fixes.test.ts` 里对区块内容的既有断言（含「禁止个人内容」那条）不受影响。

- [ ] **Step 5: 提交**

```bash
git add src/agent-config.ts src/commands/init.ts test/agent-config.test.ts
git commit -m "feat(agent-config): 区块内嵌根索引快照，写入改原子、内容未变不落盘"
```

---

### Task 3: 持久化 `agentConfig` 开关

`--no-agent-config` 目前只是 init 时的一次性跳过，没有持久化。Task 4 让守护进程周期性刷新后，会把用户明确拒绝过的区块悄悄加回去。本任务是修 bug 前置。

**Files:**
- Modify: `src/config.ts:19-30`（`Config` 接口）、`src/config.ts:137-143`（`loadConfig` 返回）
- Modify: `src/commands/init.ts:154`（构造 `cfg`）
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `Config.agentConfig?: boolean`（`loadConfig` 缺省填 `true`；仅显式 `false` 才关闭）

- [ ] **Step 1: 写失败的测试**

在 `test/cli.test.ts` 的 `describe("CLI 端到端（真实运行 dist/cli.js）")` 内，紧跟现有的 `"--no-agent-config 跳过全局提示词写入"` 用例之后追加：

```typescript
  it("agentConfig 开关持久化进 config.json", () => {
    const kb = path.join(root, "kb");
    const cfgPath = path.join(home, ".config", "knowbase", "config.json");

    expect(knowbase(["init", bare, "--dir", kb, "--no-agent-config"]).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).agentConfig).toBe(false);

    // 默认 init（复用同目录）→ 开关回到 true
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).agentConfig).toBe(true);
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run build && npx vitest run test/cli.test.ts -t "agentConfig 开关持久化"
```

预期：FAIL，`agentConfig` 为 `undefined`（不等于 `false`）。

- [ ] **Step 3: 实现**

3a. `src/config.ts` 的 `Config` 接口末尾（`watch?: boolean;` 之后）加：

```typescript
  /** 是否维护 AI agent 全局提示词托管区块（默认 true；init --no-agent-config 存 false）。 */
  agentConfig?: boolean;
```

3b. `src/config.ts` 的 `loadConfig` 返回对象末尾（`watch: parsed.watch !== false,` 之后）加：

```typescript
    agentConfig: parsed.agentConfig !== false,
```

3c. `src/commands/init.ts` 第 154 行改为：

```typescript
  const cfg: Config = {
    repoUrl: url,
    dir,
    interval,
    branch,
    agentConfig: opts.agentConfig !== false,
  };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run build && npm test
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/config.ts src/commands/init.ts test/cli.test.ts
git commit -m "fix(config): 持久化 agentConfig 开关，避免守护进程加回用户拒绝的区块"
```

---

### Task 4: 守护进程每周期刷新索引

**Files:**
- Modify: `src/sync-engine.ts`（import；新增 `refreshAgentPrompts`；`runDaemon` 内的 `runCycle`）
- Test: `test/sync-engine.test.ts`、`test/daemon-watch.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `syncAgentConfig(dir, home?)`；Task 3 的 `Config.agentConfig`
- Produces: `refreshAgentPrompts(cfg: Config, logger: Logger, home?: string): void`（永不抛错）

- [ ] **Step 1: 写失败的测试**

1a. 把 `test/sync-engine.test.ts` 第 5 行改为：

```typescript
import { syncOnce, commitMessage, refreshAgentPrompts } from "../src/sync-engine.js";
```

在文件末尾追加（局部变量用 `base` 而非 `root`，避免遮蔽模块级的 `root`）：

```typescript
describe("refreshAgentPrompts", () => {
  it("agentConfig:false → 不写任何提示词文件；true → 写入", () => {
    const base = tmpDir("refresh");
    const home = path.join(base, "home");
    const kb = path.join(base, "kb");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(kb, { recursive: true });
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n");

    const lg = new Logger(path.join(base, "log"));
    refreshAgentPrompts(
      { repoUrl: "x", dir: kb, interval: 60, branch: "main", agentConfig: false },
      lg,
      home
    );
    expect(fs.existsSync(path.join(home, ".claude", "CLAUDE.md"))).toBe(false);

    refreshAgentPrompts(
      { repoUrl: "x", dir: kb, interval: 60, branch: "main", agentConfig: true },
      lg,
      home
    );
    expect(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toContain(
      "# 索引"
    );

    fs.rmSync(base, { recursive: true, force: true });
  });

  it("写入失败时吞掉异常并记日志，不向外抛", () => {
    const base = tmpDir("refresh-err");
    const kb = path.join(base, "kb");
    fs.mkdirSync(kb, { recursive: true });
    // home 指向一个普通文件 → mkdirSync(<file>/.claude) 抛 ENOTDIR
    const brokenHome = path.join(base, "not-a-dir");
    fs.writeFileSync(brokenHome, "");

    const logFile = path.join(base, "log");
    const lg = new Logger(logFile);
    expect(() =>
      refreshAgentPrompts(
        { repoUrl: "x", dir: kb, interval: 60, branch: "main" },
        lg,
        brokenHome
      )
    ).not.toThrow();
    expect(fs.readFileSync(logFile, "utf8")).toContain("刷新 agent 提示词失败");

    fs.rmSync(base, { recursive: true, force: true });
  });
});
```

1b. 在 `test/daemon-watch.test.ts` 末尾的 describe 内追加 e2e：

```typescript
  it("索引变更后守护进程自动刷新 CLAUDE.md 中的区块", async () => {
    const kb = path.join(root, "kb");
    const init = spawnSync(
      "node",
      [CLI, "init", bare, "--dir", kb, "--interval", "3600"],
      { encoding: "utf8", env: envFor() }
    );
    expect(init.status).toBe(0);

    // init 时仓库还没有 index.md → 区块应是回退文案
    const claude = path.join(home, ".claude", "CLAUDE.md");
    expect(fs.readFileSync(claude, "utf8")).toContain("暂无");

    daemon = spawn("node", [CLI, "daemon"], { env: envFor(), stdio: "ignore" });

    const statePath = path.join(home, ".config", "knowbase", "daemon.state.json");
    const started = await waitFor(() => {
      try {
        return !!JSON.parse(fs.readFileSync(statePath, "utf8")).lastCycleAt;
      } catch {
        return false;
      }
    }, 10000);
    expect(started).toBe(true);

    // 写入索引 → 监听触发同步周期 → 周期末刷新区块
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n- 角色/：角色定义\n");

    const refreshed = await waitFor(
      () => fs.readFileSync(claude, "utf8").includes("角色定义"),
      15000
    );
    expect(refreshed).toBe(true);
    expect(fs.readFileSync(claude, "utf8")).toContain("### 知识库索引");
  }, 40000);
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run build && npx vitest run test/sync-engine.test.ts -t "refreshAgentPrompts"
```

预期：FAIL，`refreshAgentPrompts` 不存在（TS 报不存在导出成员）。

- [ ] **Step 3: 实现**

3a. `src/sync-engine.ts` 顶部 import 区加：

```typescript
import { syncAgentConfig } from "./agent-config.js";
```

3b. 在 `runDaemon` 之前（`anotherDaemonRunning` 之后）插入：

```typescript
/**
 * 每个同步周期末刷新 agent 提示词中的知识库索引快照。
 *
 * 纯本地读 + 写提示词文件，不碰 git，因此不受 .knowbase-pause 影响。
 * 任何异常只记日志：不能影响 SyncResult / DaemonState，也不能让守护进程退出。
 */
export function refreshAgentPrompts(
  cfg: Config,
  logger: Logger,
  home?: string
): void {
  if (cfg.agentConfig === false) return;
  try {
    const changes = syncAgentConfig(cfg.dir, home);
    const touched = changes.filter((c) => c.action !== "unchanged");
    if (touched.length > 0) {
      logger.log(
        `agent 提示词索引已刷新：${touched.map((c) => c.name).join(", ")}`
      );
    }
  } catch (e) {
    logger.log(
      `刷新 agent 提示词失败（已忽略）：${e instanceof Error ? e.message : String(e)}`
    );
  }
}
```

3c. 在 `runDaemon` 内，把 `runCycle` 的定义改为在 try/catch **之后**调用刷新——同步出错时索引可能仍然变了，刷新不该被跳过；而 `refreshAgentPrompts` 内部已包异常，放在这里不会污染 `lastError`：

```typescript
  const runCycle = (): void => {
    try {
      const r = syncOnce(cfg, deps);
      state.lastCycleAt = new Date().toISOString();
      state.paused = r.paused;
      state.lastError = r.error;
      if (!r.error && !r.paused) {
        state.lastOkCycleAt = state.lastCycleAt;
        if (r.committed || r.merged || r.pushed) {
          state.lastSyncOkAt = state.lastCycleAt;
        }
      }
      writeDaemonState(state);
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e);
      state.lastCycleAt = new Date().toISOString();
      writeDaemonState(state);
      logger.log(`守护循环异常（已捕获）：${state.lastError}`);
    }
    refreshAgentPrompts(cfg, logger);
  };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run build && npm test
```

预期：全部 PASS，含新增的 2 个单元用例与 1 个 e2e 用例。

- [ ] **Step 5: 提交**

```bash
git add src/sync-engine.ts test/sync-engine.test.ts test/daemon-watch.test.ts
git commit -m "feat(sync): 每个同步周期末刷新 agent 提示词中的索引快照"
```

---

### Task 5: `status` 报告索引注入状态

这个机制默认静默运行，用户无从感知是否生效——不给可见性，出问题时无从下手。

**Files:**
- Modify: `src/commands/status.ts`（import；在「冲突副本」段之前插入）
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `readIndex(dir): IndexResult`；Task 3 的 `Config.agentConfig`
- Produces: 无（仅终端输出）

- [ ] **Step 1: 写失败的测试**

在 `test/cli.test.ts` 的同一 describe 内追加：

```typescript
  it("status 报告索引注入状态：缺失 / 已注入 / 已关闭", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    // 仓库无 index.md → 提示缺失并计入需要注意
    const missing = knowbase(["status"]);
    expect(missing.out).toContain("agent 提示词");
    expect(missing.out).toContain("index.md");

    // 有 index.md → 报告文件名与体积
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n- 角色/\n");
    const injected = knowbase(["status"]);
    expect(injected.out).toMatch(/agent 提示词：已注入 index\.md（[\d.]+KB）/);

    // 关闭开关 → 报告已关闭
    expect(knowbase(["init", bare, "--dir", kb, "--no-agent-config"]).code).toBe(0);
    expect(knowbase(["status"]).out).toContain("agent 提示词：已关闭");
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run build && npx vitest run test/cli.test.ts -t "status 报告索引注入状态"
```

预期：FAIL，输出中没有「agent 提示词」。

- [ ] **Step 3: 实现**

3a. `src/commands/status.ts` 的 import 区加：

```typescript
import { readIndex, INDEX_MAX_BYTES } from "../agent-config.js";
```

3b. 在 `// 冲突副本` 注释之前插入：

```typescript
  // agent 提示词索引（这个机制默认静默运行，必须给出可见性）
  console.log("");
  if (cfg.agentConfig === false) {
    console.log("agent 提示词：已关闭（init 时用了 --no-agent-config）");
  } else {
    const idx = readIndex(cfg.dir);
    if (!idx.name) {
      console.log("agent 提示词：已启用，但知识库根目录没有 index.md");
      anomalies.push(
        "知识库根目录缺少 index.md——agent 拿不到内容地图，确认索引维护 agent 是否在运行。"
      );
    } else {
      const kb = (idx.bytes / 1024).toFixed(1);
      const note = idx.truncated ? `，超 ${INDEX_MAX_BYTES / 1024}KB 已截断` : "";
      console.log(`agent 提示词：已注入 ${idx.name}（${kb}KB${note}）`);
    }
  }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run build && npm test
```

预期：全部 PASS。注意既有用例 `"status 反映：守护进程未运行 + 冲突副本（AC4）"` 断言的是 `anomalies` 相关文本与退出码 1；新增的「缺少 index.md」也会进 `anomalies`，退出码仍为 1，该用例不受影响。

- [ ] **Step 5: 提交**

```bash
git add src/commands/status.ts test/cli.test.ts
git commit -m "feat(status): 报告 agent 提示词索引注入状态（缺失时给出提示）"
```

---

### Task 6: 文档与版本

**Files:**
- Modify: `README.md`（「与 AI agent 集成（自动）」章节）
- Modify: `package.json:3`（version）

**Interfaces:**
- Consumes: 前 5 个 task 的全部行为
- Produces: 无

- [ ] **Step 1: 更新 README**

在 `README.md` 的「与 AI agent 集成（自动）」章节里，把展示托管区块的代码块替换为：

```markdown
<!-- KNOWBASE:START （由 knowbase 自动管理，勿手动编辑本区块） -->
## 组织知识库（knowbase）
本机知识库位于：`~/org-kb`
...（读写准则 / 暂停约定 / 导航约定）...

### 知识库索引（根 index.md 快照，由 knowbase 自动同步）
...（知识库根 index.md 全文）...
<!-- KNOWBASE:END -->
```

并在该章节的要点列表（「幂等 / 不侵入 / 可逆」那几条）前插入：

```markdown
**自动索引注入**：区块里内嵌知识库根目录 `index.md` 的全文快照，agent 一开始就知道知识库里有什么，不必被提示才去 grep。

- 每个同步周期自动刷新：索引变了（本地改的或从远端拉来的），提示词区块随之更新，下次会话即生效。
- 文件名大小写不敏感：`index.md` / `Index.md` / `INDEX.md` 都认（避免 macOS 能读、Linux 读不到的跨平台不一致）。
- 上限 8KB：超出部分在行边界截断并附上完整文件路径，防止索引长起来静默吃掉每次会话的上下文预算。
- 根目录还没有 `index.md` 时不报错，区块中改为提示 agent 直接 grep 全库。
- 索引内容本身由你自己维护（人工或专门的索引维护 agent）——knowbase 只负责注入，不生成、不覆盖。
- 子目录索引不注入：区块里的导航约定会让 agent 进入子目录前先读该目录的 `index.md`。
```

- [ ] **Step 2: 升版本号**

`package.json` 第 3 行：

```json
  "version": "0.3.0",
```

- [ ] **Step 3: 全量验证**

```bash
npm run build && npm test
```

预期：全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add README.md package.json
git commit -m "docs: 知识库索引自动注入（0.3.0）"
```

---

## 验证清单（全部 task 完成后）

- [ ] `npm run build && npm test` 全绿
- [ ] 手动验证一次完整链路（在临时 HOME 下，**不碰真实 `~/.claude/CLAUDE.md`**）。第二次 `init` 是为了触发刷新——见下方注意事项：

```bash
KB=$(mktemp -d); H=$(mktemp -d); O=$(mktemp -d)/origin.git; git init --bare -b main "$O" >/dev/null; export HOME="$H" XDG_CONFIG_HOME="$H/.config" KNOWBASE_SKIP_AUTOSTART=1; node dist/cli.js init "$O" --dir "$KB" >/dev/null && grep -q "暂无" "$H/.claude/CLAUDE.md" && echo "✓ 无索引时回退文案正确"; printf '# 索引\n- 角色/：角色定义\n' > "$KB/index.md"; node dist/cli.js init "$O" --dir "$KB" >/dev/null && grep -q "角色定义" "$H/.claude/CLAUDE.md" && echo "✓ 索引已注入" || echo "✗ 未注入"; node dist/cli.js status | grep "agent 提示词"
```

**注意：`knowbase sync` 不会刷新提示词。** 它走 `syncOnce`，而刷新挂在 `runDaemon` 的 `runCycle` 上——只有守护进程的周期和 `init` 会刷。这是 spec §5.1 的原样实现，但对「手动改完索引想立刻生效」的用户不直观。若要让 `sync` 也刷新，在 `src/commands/sync.ts` 的 `syncOnce` 之后加一行 `refreshAgentPrompts(cfg, logger)` 即可，**不在本计划范围内**——需要先确认是否要做。
