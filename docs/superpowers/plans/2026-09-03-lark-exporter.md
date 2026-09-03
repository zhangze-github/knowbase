# 飞书 exporter（knowbase exporter）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `knowbase exporter` 长驻子命令：轮询飞书知识库（wiki space），把变更文档增量导出为 Markdown（**每个文件顶部 frontmatter 携带 `feishu_url`，这是 agent 回飞书修改的入口，一级验收项**），commit + push 到镜像 git 仓库，并维护 `.knowbase-mirror.json`。

**Architecture:** 新目录 `src/exporter/`，五个单一职责模块：`manifest.ts`（状态清单读写）、`tree-diff.ts`（路径规划 + 增量 diff，纯函数）、`lark-client.ts`（飞书 API 薄封装，fetch 可注入）、`docx-md.ts`（docx 块 → Markdown，纯函数）、`exporter.ts`（编排循环）。CLI 入口 `src/commands/exporter.ts`。飞书 API 一律用 Node 18+ 全局 `fetch`，**不引入任何 SDK**。测试：转换器/差分用手写 fixture 纯函数测；编排用 fake client + 真实本地 bare 仓库集成测。

**Tech Stack:** TypeScript 5.7 ESM/NodeNext（import 带 `.js` 后缀）、Node ≥ 18（全局 fetch）、`node:crypto`（sha256）、vitest。

**设计依据：** `docs/superpowers/specs/2026-09-02-lark-mirror-mode-design.md` §3（exporter 全部小节）。API 形状依据 feishu-pages 源码实证（见各任务注释）。

## Global Constraints

- 运行时依赖只有 `commander` + `update-notifier`，**不得新增**（飞书 API 用全局 fetch 手写）。
- 循环 never throw、never exit（spec §3.6）；单篇失败记日志跳过、下轮重试；429/`code 99991400` 按 `x-ogw-ratelimit-reset` 头退避。
- 中文 why-注释，重要处引用 spec 章节号。
- 每个导出文件顶部必须是如下 frontmatter（spec §3.5，用户点名的硬性要求）：
  ```
  ---
  feishu_url: https://<host>/wiki/<node_token>
  title: <JSON 转义的标题>
  synced_at: <ISO8601>
  managed_by: knowbase-mirror
  ---
  ```
- `.knowbase-mirror.json` 键名 snake_case；成员侧已消费 `version` / `last_sync_at` / `last_full_check_at` / `agent_inbox_url`（不得破坏）；exporter 私有字段：`space_id`、`host`、`nodes`。
- exporter 绝不触碰仓库内 `skills/` 目录（spec §8）。
- 飞书 API 端点（feishu-pages 实证）：
  - `POST {endpoint}/open-apis/auth/v3/tenant_access_token/internal` body `{app_id, app_secret}` → `{code, tenant_access_token, expire}`
  - `GET {endpoint}/open-apis/wiki/v2/spaces/{space_id}/nodes?page_size=50[&parent_node_token=][&page_token=]` → `{code, data:{items, has_more, page_token}}`，item 字段：`node_token, obj_token, obj_type, parent_node_token, title, obj_edit_time, has_child`
  - `GET {endpoint}/open-apis/wiki/v2/spaces/get_node?token={node_token}` → `{code, data:{node}}`
  - `GET {endpoint}/open-apis/docx/v1/documents/{obj_token}/blocks?page_size=500&document_revision_id=-1[&page_token=]` → `{code, data:{items: Block[], has_more, page_token}}`（扁平块列表，靠 `children: string[]` 组树，根为 `block_type===1`）
  - endpoint 默认 `https://open.feishu.cn`。
- 测试跑法：`npx vitest run <file>`；全量 `npm test && npm run build`；提交消息风格 `feat(exporter): <中文>`，一个 Task 一个 commit。

---

### Task 1: manifest 读写（`src/exporter/manifest.ts`）

**Files:**
- Create: `src/exporter/manifest.ts`
- Test: `test/exporter-manifest.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MirrorNodeState { path: string; obj_edit_time: string; hash: string }
  export interface ExporterManifest {
    version: 1;
    space_id: string;
    /** 租户域名（如 xxx.feishu.cn），拼 feishu_url 用 */
    host: string;
    last_sync_at?: string;
    last_full_check_at?: string;
    agent_inbox_url?: string;
    /** node_token → 导出状态；exporter 私有，成员侧不读 */
    nodes: Record<string, MirrorNodeState>;
  }
  export function newManifest(spaceId: string, host: string, inboxUrl?: string): ExporterManifest
  export function readExporterManifest(repoDir: string): ExporterManifest | null  // 缺失/损坏 → null
  export function writeExporterManifest(repoDir: string, m: ExporterManifest): void  // JSON 2 空格缩进 + 末尾换行
  ```
- Consumes: `MIRROR_MANIFEST` 常量（`src/mirror.ts`，文件名复用，保证成员侧识别同一文件）。

- [ ] **Step 1: 失败测试**

```ts
// test/exporter-manifest.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpDir } from "./helpers.js";
import { MIRROR_MANIFEST } from "../src/mirror.js";
import {
  newManifest,
  readExporterManifest,
  writeExporterManifest,
} from "../src/exporter/manifest.js";

describe("exporter manifest", () => {
  it("new → write → read 往返，文件名与成员侧一致", () => {
    const dir = tmpDir("em");
    const m = newManifest("spc123", "acme.feishu.cn", "https://acme.feishu.cn/wiki/Inbox1");
    m.nodes["nodeA"] = { path: "a.md", obj_edit_time: "100", hash: "h1" };
    writeExporterManifest(dir, m);
    expect(fs.existsSync(path.join(dir, MIRROR_MANIFEST))).toBe(true);
    const r = readExporterManifest(dir)!;
    expect(r.version).toBe(1);
    expect(r.space_id).toBe("spc123");
    expect(r.host).toBe("acme.feishu.cn");
    expect(r.agent_inbox_url).toContain("Inbox1");
    expect(r.nodes["nodeA"].hash).toBe("h1");
    // 成员侧契约字段可被成员侧读取
    expect(JSON.parse(fs.readFileSync(path.join(dir, MIRROR_MANIFEST), "utf8"))).toHaveProperty("version", 1);
  });

  it("缺失/损坏 → null", () => {
    const dir = tmpDir("em");
    expect(readExporterManifest(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, MIRROR_MANIFEST), "{broken");
    expect(readExporterManifest(dir)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑失败** — `npx vitest run test/exporter-manifest.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现**

```ts
// src/exporter/manifest.ts
import fs from "node:fs";
import path from "node:path";
import { MIRROR_MANIFEST } from "../mirror.js";

/** 单个 wiki 节点的导出状态（spec §3.3-2）。 */
export interface MirrorNodeState {
  /** 仓库内相对路径。 */
  path: string;
  /** 上次导出时该节点的 obj_edit_time（字符串秒级时间戳，来自飞书原样保存）。 */
  obj_edit_time: string;
  /** 导出 md 内容（不含 frontmatter 的 synced_at 行，见 exporter.ts contentHash）的 sha256。 */
  hash: string;
}

/**
 * exporter 侧的完整清单（spec §3.3-8）：与成员侧共用同一个文件——
 * 成员侧只读 version/last_sync_at/last_full_check_at/agent_inbox_url 四个字段，
 * space_id/host/nodes 是 exporter 私有状态，随仓库分发但成员侧不消费。
 */
export interface ExporterManifest {
  version: 1;
  space_id: string;
  /** 租户域名（如 acme.feishu.cn）：node_token 拼 feishu_url 必需（spec §3.5）。 */
  host: string;
  last_sync_at?: string;
  last_full_check_at?: string;
  agent_inbox_url?: string;
  nodes: Record<string, MirrorNodeState>;
}

export function newManifest(spaceId: string, host: string, inboxUrl?: string): ExporterManifest {
  const m: ExporterManifest = { version: 1, space_id: spaceId, host, nodes: {} };
  if (inboxUrl) m.agent_inbox_url = inboxUrl;
  return m;
}

export function readExporterManifest(repoDir: string): ExporterManifest | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(repoDir, MIRROR_MANIFEST), "utf8")
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const m = parsed as ExporterManifest;
    if (!m.nodes) m.nodes = {};
    return m;
  } catch {
    return null;
  }
}

export function writeExporterManifest(repoDir: string, m: ExporterManifest): void {
  fs.writeFileSync(
    path.join(repoDir, MIRROR_MANIFEST),
    JSON.stringify(m, null, 2) + "\n",
    "utf8"
  );
}
```

- [ ] **Step 4: 跑通过** — 同命令 PASS
- [ ] **Step 5: 提交** — `git add src/exporter/manifest.ts test/exporter-manifest.test.ts && git commit -m "feat(exporter): 镜像清单 exporter 侧读写"`

---

### Task 2: 路径规划与增量 diff（`src/exporter/tree-diff.ts`，纯函数）

**Files:**
- Create: `src/exporter/tree-diff.ts`
- Test: `test/exporter-tree-diff.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WikiNode {
    node_token: string; obj_token: string; obj_type: string;
    parent_node_token: string; title: string; obj_edit_time: string; has_child: boolean;
  }
  export interface PlannedNode { node: WikiNode; path: string }
  export function sanitizeTitle(title: string): string
  export function planPaths(nodes: WikiNode[], rootToken?: string): Map<string, PlannedNode>
  export interface TreeDiff {
    toExport: PlannedNode[];                       // 新增或 obj_edit_time 变化（含移动且变化者）
    toMove: { from: string; to: PlannedNode }[];   // 路径变化（git mv；可与 toExport 交叠）
    toRemove: { node_token: string; path: string }[];
  }
  export function diffTree(planned: Map<string, PlannedNode>, prev: Record<string, MirrorNodeState>): TreeDiff
  ```
- Consumes: Task 1 的 `MirrorNodeState`。

**路径规则（spec §3.3-4，实现与测试都以此为准）：**
- `sanitizeTitle`：`/ \ : * ? " < > |` 与控制字符替换为 `-`，去首尾空白与首尾 `.`，连续 `-` 折叠为一个；空结果 → 用 node_token 前 8 位。
- 无子节点 → `<父路径>/<title>.md`；有子节点 → 目录 `<父路径>/<title>/`，节点自身内容存 `<父路径>/<title>/<title>.md`（目录同名文件，agent 直观可读）。
- 同父下清洗后重名 → 后者追加 `-<node_token 前 6 位>`（目录与文件各自查重；`title.md` 与目录 `title/` 同名不冲突，允许）。
- `rootToken` 给定时只规划该节点的后代（不含它自身），路径以子树为根。
- 遍历顺序按输入数组顺序稳定（`listAllSpaceNodes` 保证 BFS 序）。

- [ ] **Step 1: 失败测试**

```ts
// test/exporter-tree-diff.test.ts
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
    expect(sanitizeTitle("///")).not.toBe("");
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
```

- [ ] **Step 2: 跑失败** — FAIL
- [ ] **Step 3: 实现**

```ts
// src/exporter/tree-diff.ts
import type { MirrorNodeState } from "./manifest.js";

/** wiki 节点（字段名与飞书 API 原样对齐，来源见计划 Global Constraints）。 */
export interface WikiNode {
  node_token: string;
  obj_token: string;
  obj_type: string;
  parent_node_token: string;
  title: string;
  obj_edit_time: string;
  has_child: boolean;
}

export interface PlannedNode { node: WikiNode; path: string }

/**
 * 标题 → 合法文件名（spec §3.3-4）。跨平台最严格集（Windows）为准：
 * 非法字符替换为 -、折叠连续 -、去首尾空白与点；清洗成空时用 token 兜底
 * 的逻辑在 planPaths（这里拿不到 token）。
 */
export function sanitizeTitle(title: string): string {
  return title
    .trim() // 先去首尾空白再替换：否则空白变成的 - 会残留在首尾
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^\.+|[\s.]+$/g, "");
}

/**
 * 节点树 → 仓库相对路径（spec §3.3-4）。
 * 有子节点的节点既是目录又有正文：目录 <title>/ + 正文 <title>/<title>.md，
 * agent 看树即懂；node_token 是稳定身份，标题变化产生 move 而非删建。
 */
export function planPaths(nodes: WikiNode[], rootToken?: string): Map<string, PlannedNode> {
  const byParent = new Map<string, WikiNode[]>();
  for (const node of nodes) {
    const arr = byParent.get(node.parent_node_token) ?? [];
    arr.push(node);
    byParent.set(node.parent_node_token, arr);
  }
  const out = new Map<string, PlannedNode>();

  const walk = (parentToken: string, parentDir: string): void => {
    const children = byParent.get(parentToken) ?? [];
    const used = new Set<string>(); // 本层已占用的「基名」（目录与文件分别带后缀区分）
    for (const node of children) {
      let base = sanitizeTitle(node.title);
      if (base === "") base = node.node_token.slice(0, 8);
      // 同父重名：目录看 base+"/"，文件看 base+".md"
      const key = node.has_child ? base + "/" : base + ".md";
      let finalBase = base;
      if (used.has(key)) {
        finalBase = `${base}-${node.node_token.slice(0, 6)}`;
      }
      used.add(node.has_child ? finalBase + "/" : finalBase + ".md");
      const prefix = parentDir === "" ? "" : parentDir + "/";
      if (node.has_child) {
        const dir = prefix + finalBase;
        out.set(node.node_token, { node, path: `${dir}/${finalBase}.md` });
        walk(node.node_token, dir);
      } else {
        out.set(node.node_token, { node, path: `${prefix}${finalBase}.md` });
      }
    }
  };

  walk(rootToken ?? "", "");
  return out;
}

export interface TreeDiff {
  /** 需要（重新）导出内容：新增，或 obj_edit_time 变化（含移动且变化者）。 */
  toExport: PlannedNode[];
  /** 路径变化 → git mv；与 toExport 可交叠（先 mv 再重写）。 */
  toMove: { from: string; to: PlannedNode }[];
  /** 清单里有、树上已消失 → 删除文件。 */
  toRemove: { node_token: string; path: string }[];
}

export function diffTree(
  planned: Map<string, PlannedNode>,
  prev: Record<string, MirrorNodeState>
): TreeDiff {
  const toExport: PlannedNode[] = [];
  const toMove: TreeDiff["toMove"] = [];
  const toRemove: TreeDiff["toRemove"] = [];

  for (const [token, p] of planned) {
    const old = prev[token];
    if (!old) {
      toExport.push(p);
      continue;
    }
    if (old.path !== p.path) toMove.push({ from: old.path, to: p });
    if (old.obj_edit_time !== p.node.obj_edit_time) toExport.push(p);
  }
  for (const [token, old] of Object.entries(prev)) {
    if (!planned.has(token)) toRemove.push({ node_token: token, path: old.path });
  }
  return { toExport, toMove, toRemove };
}
```

- [ ] **Step 4: 跑通过**；注意首测「a-b-c-」断言与实现的首尾清理规则冲突时以实现规则为准修测试（`a/b:c*?` 清洗后结尾的 `-` 不在首尾空白/点清理范围内，保留）。
- [ ] **Step 5: 全量回归 + 提交** — `npm test`；`git commit -m "feat(exporter): 节点树路径规划与增量 diff"`

---

### Task 3: 飞书 API client（`src/exporter/lark-client.ts`）

**Files:**
- Create: `src/exporter/lark-client.ts`
- Test: `test/exporter-lark-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LarkClientOpts {
    appId: string; appSecret: string;
    endpoint?: string;              // 默认 https://open.feishu.cn
    fetchFn?: typeof fetch;         // 测试注入
    sleep?: (ms: number) => Promise<void>; // 测试注入（默认 setTimeout）
  }
  export class LarkClient {
    constructor(opts: LarkClientOpts)
    tenantToken(): Promise<string>
    request<T>(method: "GET" | "POST", path: string, query?: Record<string, string>, body?: unknown): Promise<T>
    listAllSpaceNodes(spaceId: string, rootNodeToken?: string): Promise<WikiNode[]>
    getNode(token: string): Promise<{ space_id: string; node: WikiNode }>
    listDocBlocks(documentId: string): Promise<DocxBlock[]>
  }
  export interface DocxBlock { block_id: string; block_type: number; parent_id?: string; children?: string[]; [k: string]: unknown }
  ```
- Consumes: Task 2 的 `WikiNode`。

**行为规约：**
- `tenantToken`：POST `/open-apis/auth/v3/tenant_access_token/internal`；缓存 token，`expire` 秒（响应字段）减 300 秒后过期重取。
- `request`：自动带 `Authorization: Bearer <token>`；响应 JSON `code !== 0` → throw（含 code 与 msg，由 exporter 循环兜）；HTTP 429 或 `code === 99991400` → 读响应头 `x-ogw-ratelimit-reset`（秒，缺省 5）sleep 后重试，最多 5 次后 throw。
- `listAllSpaceNodes`：BFS——先列 space 顶层（不带 `parent_node_token`），对每个 `has_child` 节点再列其子；每层 `page_size=50` + `page_token` 分页循环；`rootNodeToken` 给定时从该节点的孩子开始。返回数组保持 BFS 序。
- `listDocBlocks`：`page_size=500&document_revision_id=-1` + 分页聚合。

- [ ] **Step 1: 失败测试**（fake fetch：按 URL 前缀路由返回预设 JSON；一个可编程 429 计数器）

```ts
// test/exporter-lark-client.test.ts
import { describe, it, expect } from "vitest";
import { LarkClient } from "../src/exporter/lark-client.js";

type Route = (url: string, init?: RequestInit) => { status?: number; headers?: Record<string, string>; body: unknown };

function fakeFetch(route: Route): typeof fetch {
  return (async (url: any, init?: any) => {
    const r = route(String(url), init);
    return {
      status: r.status ?? 200,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body,
    } as unknown as Response;
  }) as typeof fetch;
}

function client(route: Route) {
  const calls: string[] = [];
  const c = new LarkClient({
    appId: "id", appSecret: "sec",
    fetchFn: fakeFetch((u, i) => { calls.push(u); return route(u, i); }),
    sleep: async () => {},
  });
  return { c, calls };
}

const TOKEN_BODY = { code: 0, tenant_access_token: "tok1", expire: 7200 };

describe("LarkClient", () => {
  it("token 缓存：两次请求只取一次 token", async () => {
    const { c, calls } = client((u) => {
      if (u.includes("tenant_access_token")) return { body: TOKEN_BODY };
      return { body: { code: 0, data: { items: [], has_more: false } } };
    });
    await c.listAllSpaceNodes("spc");
    await c.listAllSpaceNodes("spc");
    expect(calls.filter((u) => u.includes("tenant_access_token")).length).toBe(1);
  });

  it("code!==0 → throw 含 code 与 msg", async () => {
    const { c } = client((u) =>
      u.includes("tenant_access_token")
        ? { body: TOKEN_BODY }
        : { body: { code: 1254005, msg: "not found" } }
    );
    await expect(c.getNode("x")).rejects.toThrow(/1254005.*not found/);
  });

  it("429 → 按 x-ogw-ratelimit-reset 退避重试后成功", async () => {
    let hits = 0;
    const { c } = client((u) => {
      if (u.includes("tenant_access_token")) return { body: TOKEN_BODY };
      hits++;
      if (hits <= 2) return { status: 429, headers: { "x-ogw-ratelimit-reset": "1" }, body: { code: 99991400 } };
      return { body: { code: 0, data: { node: { node_token: "n", obj_token: "o", obj_type: "docx", parent_node_token: "", title: "t", obj_edit_time: "1", has_child: false }, space_id: "spc" } } };
    });
    const r = await c.getNode("n");
    expect(r.node.node_token).toBe("n");
    expect(hits).toBe(3);
  });

  it("listAllSpaceNodes：分页 + 递归子节点，BFS 序", async () => {
    const top1 = { node_token: "A", obj_token: "oa", obj_type: "docx", parent_node_token: "", title: "A", obj_edit_time: "1", has_child: true };
    const top2 = { node_token: "B", obj_token: "ob", obj_type: "docx", parent_node_token: "", title: "B", obj_edit_time: "1", has_child: false };
    const kid = { node_token: "C", obj_token: "oc", obj_type: "docx", parent_node_token: "A", title: "C", obj_edit_time: "1", has_child: false };
    const { c } = client((u) => {
      if (u.includes("tenant_access_token")) return { body: TOKEN_BODY };
      if (u.includes("parent_node_token=A")) return { body: { code: 0, data: { items: [kid], has_more: false } } };
      if (u.includes("page_token=p2")) return { body: { code: 0, data: { items: [top2], has_more: false } } };
      return { body: { code: 0, data: { items: [top1], has_more: true, page_token: "p2" } } };
    });
    const nodes = await c.listAllSpaceNodes("spc");
    expect(nodes.map((n) => n.node_token)).toEqual(["A", "B", "C"]);
  });

  it("listDocBlocks 分页聚合", async () => {
    const b = (id: string) => ({ block_id: id, block_type: 2 });
    const { c } = client((u) => {
      if (u.includes("tenant_access_token")) return { body: TOKEN_BODY };
      if (u.includes("page_token=q2")) return { body: { code: 0, data: { items: [b("2")], has_more: false } } };
      return { body: { code: 0, data: { items: [b("1")], has_more: true, page_token: "q2" } } };
    });
    const blocks = await c.listDocBlocks("doc1");
    expect(blocks.map((x) => x.block_id)).toEqual(["1", "2"]);
  });
});
```

- [ ] **Step 2: 跑失败** — FAIL
- [ ] **Step 3: 实现**（要点：`request` 内统一退避循环；`listAllSpaceNodes` 用队列 BFS；URL 用 `URLSearchParams` 拼 query；全程不引第三方库）

```ts
// src/exporter/lark-client.ts（骨架，细节按测试补齐）
import type { WikiNode } from "./tree-diff.js";

export interface DocxBlock {
  block_id: string;
  block_type: number;
  parent_id?: string;
  children?: string[];
  [k: string]: unknown;
}

export interface LarkClientOpts {
  appId: string;
  appSecret: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ENDPOINT = "https://open.feishu.cn";
const MAX_RETRIES = 5;
/** token 提前刷新窗口：飞书 expire 通常 7200s，提前 5 分钟避免边界失效。 */
const TOKEN_SLACK_MS = 300 * 1000;

export class LarkClient {
  private opts: Required<Pick<LarkClientOpts, "appId" | "appSecret">> & LarkClientOpts;
  private token: string | null = null;
  private tokenExpireAt = 0;

  constructor(opts: LarkClientOpts) {
    this.opts = { endpoint: DEFAULT_ENDPOINT, ...opts };
  }

  private fetchFn(): typeof fetch {
    return this.opts.fetchFn ?? fetch;
  }
  private sleep(ms: number): Promise<void> {
    return (this.opts.sleep ?? ((m) => new Promise((r) => setTimeout(r, m))))(ms);
  }

  async tenantToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpireAt) return this.token;
    const res = await this.fetchFn()(
      `${this.opts.endpoint}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }),
      }
    );
    const body = (await res.json()) as { code: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`获取 tenant token 失败：code=${body.code} ${body.msg ?? ""}`);
    }
    this.token = body.tenant_access_token;
    this.tokenExpireAt = Date.now() + (body.expire ?? 7200) * 1000 - TOKEN_SLACK_MS;
    return this.token;
  }

  /**
   * 统一请求：鉴权 + 限流退避（HTTP 429 / code 99991400，读 x-ogw-ratelimit-reset 秒，
   * 缺省 5s，最多 5 次）+ code!==0 抛错。spec §3.6：抛错由 exporter 循环捕获记日志。
   */
  async request<T>(
    method: "GET" | "POST",
    apiPath: string,
    query?: Record<string, string>,
    reqBody?: unknown
  ): Promise<T> {
    const qs = query ? `?${new URLSearchParams(query)}` : "";
    for (let attempt = 0; ; attempt++) {
      const token = await this.tenantToken();
      const res = await this.fetchFn()(`${this.opts.endpoint}${apiPath}${qs}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: reqBody === undefined ? undefined : JSON.stringify(reqBody),
      });
      const body = (await res.json()) as { code: number; msg?: string; data?: unknown };
      if (res.status === 429 || body.code === 99991400) {
        if (attempt >= MAX_RETRIES) throw new Error(`飞书限流重试 ${MAX_RETRIES} 次仍失败：${apiPath}`);
        const reset = parseInt(res.headers.get("x-ogw-ratelimit-reset") ?? "", 10);
        await this.sleep((Number.isFinite(reset) && reset > 0 ? reset : 5) * 1000);
        continue;
      }
      if (body.code !== 0) throw new Error(`飞书 API 失败 code=${body.code} msg=${body.msg ?? ""}（${apiPath}）`);
      return body.data as T;
    }
  }

  /** 分页迭代直到 has_more=false，聚合 items。 */
  private async listAll<T>(apiPath: string, query: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const q = { ...query, ...(pageToken ? { page_token: pageToken } : {}) };
      const data = await this.request<{ items?: T[]; has_more?: boolean; page_token?: string }>("GET", apiPath, q);
      out.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return out;
  }

  /** BFS 拉全树（spec §3.3-1）：顶层 → 逐个 has_child 展开，保证输出 BFS 序。 */
  async listAllSpaceNodes(spaceId: string, rootNodeToken?: string): Promise<WikiNode[]> {
    const result: WikiNode[] = [];
    const queue: (string | undefined)[] = [rootNodeToken];
    while (queue.length > 0) {
      const parent = queue.shift();
      const q: Record<string, string> = { page_size: "50" };
      if (parent) q.parent_node_token = parent;
      const nodes = await this.listAll<WikiNode>(`/open-apis/wiki/v2/spaces/${spaceId}/nodes`, q);
      for (const node of nodes) {
        result.push(node);
        if (node.has_child) queue.push(node.node_token);
      }
    }
    return result;
  }

  async getNode(token: string): Promise<{ space_id: string; node: WikiNode }> {
    const data = await this.request<{ node: WikiNode & { space_id?: string } }>(
      "GET", "/open-apis/wiki/v2/spaces/get_node", { token }
    );
    return { space_id: (data.node as { space_id?: string }).space_id ?? "", node: data.node };
  }

  async listDocBlocks(documentId: string): Promise<DocxBlock[]> {
    return this.listAll<DocxBlock>(`/open-apis/docx/v1/documents/${documentId}/blocks`, {
      page_size: "500",
      document_revision_id: "-1",
    });
  }
}
```

注意：`listAllSpaceNodes` 顶层调用 `queue = [rootNodeToken]`，`rootNodeToken` 为 undefined 时表示列 space 顶层（不带 parent 参数）——与测试对齐。BFS 序的断言（A、B 先于 C）要求「本层全部节点入结果后才展开子层」，上面的实现天然满足（先 listAll 整层再 push 子层）。

- [ ] **Step 4: 跑通过**
- [ ] **Step 5: 全量回归 + 提交** — `git commit -m "feat(exporter): 飞书 API client（token 缓存/分页/限流退避）"`

---

### Task 4: docx → Markdown 转换器·基础块（`src/exporter/docx-md.ts`）

**Files:**
- Create: `src/exporter/docx-md.ts`
- Test: `test/exporter-docx-md.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RenderCtx {
    selfUrl: string;                                   // 本文档飞书 URL（降级占位用）
    pathForToken?: (token: string) => string | undefined;  // 库内链接改写（Task 5 用）
    urlForToken?: (token: string) => string | undefined;
  }
  export function renderDocxToMarkdown(blocks: DocxBlock[], ctx: RenderCtx): string
  ```
- Consumes: Task 3 的 `DocxBlock`。

**本任务覆盖的块类型（数值来自 feishu-docx 的 BlockType enum）：**
Page=1（根，只渲染 children，不渲染标题——标题已在 frontmatter）、Text=2、Heading1-9=3..11（`#`..`#########`，实际输出 1-6 级封顶 `######`）、Bullet=12（`- `，子块缩进 2 空格）、Ordered=13（同父连续序号 `1.` `2.`…）、Code=14（```` ```lang ````，language 数值→名称映射表：1=plaintext,8=bash,22=go,28=java,30=javascript,49=python,53=rust,63=typescript，查不到→空）、Quote=15（`> `）、TodoList=17（`- [ ]` / `- [x]`，done 取 block.todo.style.done）、Divider=22（`---`）。

**文本元素（所有含 elements 的块共用）：** `text_run.content` + `text_element_style`：bold→`**x**`、italic→`*x*`、strikethrough→`~~x~~`、inline_code→`` `x` ``、link→`[x](decodeURIComponent(link.url))`（样式可叠加，包裹顺序 code 最内、link 最外）；`equation`→`$content$`；`mention_user`→`@<user_id>`；`mention_doc`→Task 5 处理（本任务先渲染为 `[标题](原url)`）。

**块取数约定（飞书 docx v1 响应形状）：** 每种块的负载在与类型同名的字段里——`block.text.elements`、`block.heading1.elements`…`block.heading9.elements`、`block.bullet.elements`、`block.ordered.elements`、`block.code.elements` + `block.code.style.language`、`block.quote.elements`、`block.todo.elements` + `block.todo.style.done`。树：flat 数组按 `block_id` 建 map，根 = `block_type===1`，按 `children` id 顺序深度优先渲染；块级之间空行分隔，列表连续项之间单换行。

- [ ] **Step 1: 失败测试**（fixture 手写为 TS 对象；至少覆盖：各块各一、样式叠加、嵌套列表缩进、ordered 连续编号与被非列表块打断后重新计数、9 级 heading 封顶 6、未知 elements 容错）

```ts
// test/exporter-docx-md.test.ts（节选核心，用例按下述场景逐一展开）
import { describe, it, expect } from "vitest";
import { renderDocxToMarkdown } from "../src/exporter/docx-md.js";
import type { DocxBlock } from "../src/exporter/lark-client.js";

const CTX = { selfUrl: "https://acme.feishu.cn/wiki/N1" };
const run = (content: string, style: object = {}) => ({ text_run: { content, text_element_style: style } });
function doc(...body: DocxBlock[]): DocxBlock[] {
  return [
    { block_id: "root", block_type: 1, children: body.map((b) => b.block_id) },
    ...body,
  ];
}

describe("基础块渲染", () => {
  it("heading + text + 样式叠加", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "h", block_type: 3, heading1: { elements: [run("标题")] } },
      { block_id: "t", block_type: 2, text: { elements: [
        run("普通"), run("粗", { bold: true }), run("码", { inline_code: true }),
        run("链", { link: { url: encodeURIComponent("https://x.cn/a") } }),
      ] } },
    ) as DocxBlock[], CTX);
    expect(md).toContain("# 标题");
    expect(md).toContain("**粗**");
    expect(md).toContain("`码`");
    expect(md).toContain("[链](https://x.cn/a)");
  });

  it("bullet 嵌套缩进 + ordered 连续编号与打断重计", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "b1", block_type: 12, bullet: { elements: [run("一级")] }, children: ["b2"] },
      { block_id: "o1", block_type: 13, ordered: { elements: [run("甲")] } },
      { block_id: "o2", block_type: 13, ordered: { elements: [run("乙")] } },
      { block_id: "t", block_type: 2, text: { elements: [run("打断")] } },
      { block_id: "o3", block_type: 13, ordered: { elements: [run("丙")] } },
    ).concat([{ block_id: "b2", block_type: 12, bullet: { elements: [run("二级")] } }]) as DocxBlock[], CTX);
    expect(md).toContain("- 一级\n  - 二级");
    expect(md).toContain("1. 甲\n2. 乙");
    expect(md).toMatch(/打断[\s\S]*1\. 丙/);
  });

  it("code / quote / todo / divider / heading 封顶", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "c", block_type: 14, code: { elements: [run("const a=1")], style: { language: 63 } } },
      { block_id: "q", block_type: 15, quote: { elements: [run("引用")] } },
      { block_id: "td", block_type: 17, todo: { elements: [run("待办")], style: { done: true } } },
      { block_id: "d", block_type: 22 },
      { block_id: "h9", block_type: 11, heading9: { elements: [run("深")] } },
    ) as DocxBlock[], CTX);
    expect(md).toContain("```typescript\nconst a=1\n```");
    expect(md).toContain("> 引用");
    expect(md).toContain("- [x] 待办");
    expect(md).toContain("---");
    expect(md).toContain("###### 深"); // 9 级封顶 6
  });

  it("equation 与 mention_user", () => {
    const md = renderDocxToMarkdown(doc(
      { block_id: "t", block_type: 2, text: { elements: [
        { equation: { content: "E=mc^2" } },
        { mention_user: { user_id: "ou_1" } },
      ] } },
    ) as DocxBlock[], CTX);
    expect(md).toContain("$E=mc^2$");
    expect(md).toContain("@ou_1");
  });
});
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**（结构：`renderDocxToMarkdown` 建 map + 找根；`renderBlocks(ids, depth, state)` 维护 ordered 计数器（遇到非 ordered 块重置）；`renderElements(elements)` 处理样式包裹；heading 级别 `Math.min(block_type - 2, 6)`；未知 element 字段静默跳过；heading/text 的 children（飞书允许块嵌套）继续以 depth 渲染。行合并规则：列表项与其子列表间单换行，其余块间双换行。）
- [ ] **Step 4: 跑通过**
- [ ] **Step 5: 全量回归 + 提交** — `git commit -m "feat(exporter): docx→md 转换器（基础块与文本样式）"`

---

### Task 5: 转换器·复杂块与降级 + 库内链接改写

**Files:**
- Modify: `src/exporter/docx-md.ts`
- Test: `test/exporter-docx-md.test.ts`（追加 describe）

**覆盖（spec §3.3-5/6）：**
- Table=31 / TableCell=32：`block.table.property.row_size/column_size`、`block.table.cells`（cell block_id 数组，行优先）→ md 表格；cell 内容 = 其 children 渲染后压成单行（换行替换为空格、`|` 转义 `\|`）；首行为表头。
- Callout=19：children 渲染后每行加 `> ` 前缀（引用块形式保底）。
- Image=27：`> 🖼 图片见原文：[<selfUrl>](<selfUrl>)`（v1 不下载图片——保持仓库纯文本，二进制资产留待后续版本；注释说明该取舍）。
- Bitable=18 / Sheet=30 / Board=43 / Iframe=26 / File=23 / Mindnote=28 及**一切未实现类型**（default 分支）：`> ⚠ 此处为无法转换的内容（type <N>），请在飞书查看：[原文](<selfUrl>)`。
- `mention_doc`（正文里 @另一篇文档）：`pathForToken(token)` 命中 → `[标题](<相对本地路径>)（[飞书](<url>)）` 双链（spec §3.3-5）；未命中 → `[标题](<url>)`。token 取 `mention_doc.token`，url 取 `mention_doc.url` 或 `urlForToken(token)`。
- 相对路径计算：ctx 增加 `selfPath?: string`（本文档在仓库内的路径），`pathForToken` 返回仓库相对路径后用 `path.posix.relative(path.posix.dirname(selfPath), targetPath)` 转为文档相对链接。

- [ ] **Step 1: 失败测试**（追加：2x2 表格含表头与 `|` 转义；callout 前缀；image 占位含 selfUrl；bitable/未知类型占位；mention_doc 命中/未命中两种；相对路径正确性——selfPath `a/b.md` 指向 `c/d.md` → `../c/d.md`）
- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**（table 的 cells 按 row_size/column_size 切行；default 分支必须存在——转换器对任何输入 never throw，未知块一律降级占位）
- [ ] **Step 4: 跑通过**
- [ ] **Step 5: 全量回归 + 提交** — `git commit -m "feat(exporter): 转换器复杂块、降级占位与库内链接双链改写"`

---

### Task 6: 导出编排 `runExportOnce`（首轮全量）

**Files:**
- Create: `src/exporter/exporter.ts`
- Modify: `test/helpers.ts`（追加 `makeEmptyOrigin`：bare 仓库 + 空初始提交）
- Test: `test/exporter-run.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LarkClientLike {   // 集成测试注入 fake 的最小面
    listAllSpaceNodes(spaceId: string, root?: string): Promise<WikiNode[]>;
    listDocBlocks(documentId: string): Promise<DocxBlock[]>;
  }
  export interface ExporterConfig {
    repoDir: string; branch: string;
    spaceId: string; host: string;
    rootToken?: string; inboxUrl?: string;
    /** 全量对账间隔 ms，默认 24h */
    fullCheckMs?: number;
  }
  export interface ExportResult {
    exported: number; moved: number; removed: number;
    committed: boolean; pushed: boolean; error?: string;
  }
  export function runExportOnce(cfg: ExporterConfig, deps: { client: LarkClientLike; logger: Logger; now?: () => Date }): Promise<ExportResult>
  ```
- Consumes: Task 1/2/3/5 全部；`src/git.ts` 的 `addAll/commit/push/ok/hasChanges`；`src/config.ts` 的 `Logger`。

**runExportOnce 步骤（never throw，任何异常 → result.error + 日志）：**
1. `readExporterManifest(repoDir)`，无则 `newManifest(spaceId, host, inboxUrl)`（首轮）。
2. `client.listAllSpaceNodes(spaceId, rootToken)` → `planPaths` → `diffTree(planned, manifest.nodes)`。
3. `toMove`：`git mv from to`（git.ts 加 `mv(dir, from, to)` 薄封装；目标目录先 mkdirSync recursive；mv 失败降级为 fs rename，均失败记日志跳过）；更新 manifest.nodes[token].path。
4. `toExport` 逐个：`obj_type === "docx"` → `listDocBlocks(obj_token)` → `renderDocxToMarkdown`（ctx：selfUrl=`https://${host}/wiki/${node_token}`、selfPath、pathForToken/urlForToken 基于 planned 集合）；其它 obj_type → 占位正文 `> 此为飞书 ${obj_type}，请在飞书打开：[原文](selfUrl)`。**写文件 = frontmatter + 正文**；frontmatter 见 Global Constraints，title 用 `JSON.stringify(node.title)` 转义。hash = sha256(正文 + title)（**刻意不含 synced_at**——否则每轮全量对账都会误判内容变化）；内容 hash 与 manifest 相同则跳过写盘（全量对账幂等的关键）。单篇失败：记日志、跳过、不更新该节点 manifest（下轮重试）。
5. `toRemove`：删除文件（`fs.rmSync(force)`）+ 清 manifest 项；删空目录顺手清理。
6. 更新 `manifest.last_sync_at = now.toISOString()`；全量对账轮更新 `last_full_check_at`。`writeExporterManifest`。
7. `git.hasChanges` → `addAll` + `commit("mirror: +A ~C -R" 变更计数)` + `push`；无变化仅 manifest 的 `last_sync_at` 变——**为避免空转提交风暴，last_sync_at 变化也照常提交推送，但 commit message 用 `mirror: heartbeat`**（成员侧 status 的新鲜度依赖它，spec §3.4/§4.4；注释说明该取舍）。push 失败：result.error，下轮重试。
8. `skills/` 保护：diff/写盘/删除路径若落在 `skills/` 内一律跳过并记日志（结构上 planPaths 不会产生，但 toRemove 清理旧状态时防御一道，spec §8）。

- [ ] **Step 1: helpers 与失败测试**

fake client：内存里一组 WikiNode + 每 obj_token 一组 blocks，可变（测试中修改后再跑一轮）。测试场景（真实 git bare 仓库 + clone 出的 repoDir）：
  1. 首轮全量：3 个节点（1 目录+1 子文档+1 顶层）→ 文件落盘、**每个文件以 `---\nfeishu_url: https://host/wiki/<token>` 开头（用户核心验收）**、目录结构正确、manifest.nodes 3 项、产生 1 个 commit 且推到 bare（在 bare 上 `git log` 验证）、`ExportResult.exported===3, pushed===true`。
  2. 非 docx 节点（obj_type "sheet"）→ 占位 md 也带 frontmatter。
  3. 单篇 blocks 拉取失败（fake 对某 token throw）→ 该篇跳过、其余成功、result.error 为空但日志有记录、manifest 无该节点（下轮重试）。

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**（`src/git.ts` 追加 `mv(dir, from, to): GitResult`；exporter.ts 按上述 8 步；sha256 用 `node:crypto` 的 `createHash("sha256")`）
- [ ] **Step 4: 跑通过**
- [ ] **Step 5: 全量回归 + 提交** — `git commit -m "feat(exporter): runExportOnce 编排——全量导出、frontmatter、git 发布"`

---

### Task 7: 增量周期与全量对账

**Files:**
- Modify: `src/exporter/exporter.ts`
- Test: `test/exporter-run.test.ts`（追加 describe）

**行为：**
- 第二轮无任何节点变化 → 只有 heartbeat 提交（manifest.last_sync_at），`exported===0`。
- 修改某节点 `obj_edit_time` + blocks → 只重导该篇（fake client 记录 listDocBlocks 调用次数验证）。
- 改标题 → `git mv`（旧路径消失、新路径存在、`git log --follow` 能追到旧历史或 status 显示 rename；断言 exported 是否含内容重导取决于 edit_time 是否同时变化）。
- 删除节点 → 文件删除、manifest 清项。
- 全量对账：`now - last_full_check_at > fullCheckMs`（或 manifest 缺该字段）→ 本轮忽略 edit_time，全部节点重渲染比 hash，hash 相同不写盘不提交（幂等验证：连续两轮全量对账，第二轮零变更）；完成后写 `last_full_check_at`。
- 每轮开始若上一轮 push 失败残留本地领先提交 → 本轮结束正常 push 补上（用 fake 的 bare 仓库拒绝一次 push 再放行来测——复用 `denyPush/allowPush` helpers）。

- [ ] **Step 1: 失败测试**（按上述 6 场景各一用例）
- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**（全量对账分支：diffTree 结果之外把 unchanged 节点也加入重渲染集合；比 hash 决定是否写盘）
- [ ] **Step 4: 跑通过**
- [ ] **Step 5: 全量回归 + 提交** — `git commit -m "feat(exporter): 增量导出、git mv、删除与每日全量对账"`

---

### Task 8: CLI 命令与守护循环（`knowbase exporter`）

**Files:**
- Create: `src/commands/exporter.ts`
- Modify: `src/cli.ts`（注册命令）、`src/exporter/exporter.ts`（追加 `runExporterDaemon`）
- Test: `test/exporter-cli.test.ts`

**命令规约：**
```
knowbase exporter --repo <已 clone 的镜像仓库路径> --space <wiki 链接或 space_id>
                  [--host acme.feishu.cn] [--root <node_token>] [--branch main]
                  [--interval 120] [--inbox-url <url>] [--once] [--full]
env: KNOWBASE_LARK_APP_ID / KNOWBASE_LARK_APP_SECRET（必填，不走 CLI 参数避免进 shell history）
     KNOWBASE_LARK_ENDPOINT（可选，默认 https://open.feishu.cn）
```
- `--space` 为 URL 时：从 URL host 得 `host`、从路径 `/wiki/<token>` 得节点 token → `client.getNode` 解析 space_id，并把该 token 作为 `--root`（用户给的就是子树根）；URL 是 space 首页形态（`/wiki/space/<space_id>`? 直接含 space_id 的路径）则解析 space_id、host 取 URL host。为纯 space_id 时必须显式 `--host`。
- `--once`：跑一轮 `runExportOnce` 退出（退出码：error ? 1 : 0）——cron 部署与冒烟验证入口。
- 默认：`runExporterDaemon`——`while(true){ runExportOnce; sleep(interval) }`，never exit，SIGTERM 优雅退出；启动时打印配置摘要（不打印 secret）。
- 缺 env / 缺参数 → 打印清晰错误与准备步骤提示（自建应用、加 bot 进 space），退出码 2。

- [ ] **Step 1: 失败测试**（可测部分：参数解析抽为纯函数 `parseExporterArgs(opts, env)` 导出测试——URL 三种形态解析、缺 env 报错、space_id+缺 host 报错；daemon 循环用注入 sleep + 最大轮数的变体或只测 `--once` 路径：fake 不可行处以 runExportOnce 已覆盖为由仅测解析层）
- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**（cli.ts 注册 `.command("exporter")` 带上述 flags；解析层纯函数 + 组装层薄；`getNode` 调用只在 URL 带节点 token 时发生）
- [ ] **Step 4: 跑通过 + `npm run build`**
- [ ] **Step 5: 全量回归 + 提交** — `git commit -m "feat(exporter): CLI 命令、参数解析与守护循环"`

---

### Task 9: 部署物与文档

**Files:**
- Create: `deploy/exporter/Dockerfile`、`deploy/exporter/knowbase-exporter.service`、`deploy/exporter/README.md`
- Modify: `README.md`（「部署 exporter」章节）

**内容要求：**
- Dockerfile：`FROM node:22-slim` + `apt-get install -y git ca-certificates` + `npm i -g knowbase` + entrypoint 脚本（首次 clone `$KNOWBASE_MIRROR_REPO_URL` 到 /data/repo（挂 volume），配置 git 身份 `knowbase-exporter`，然后 `knowbase exporter --repo /data/repo --space "$KNOWBASE_LARK_SPACE" ...`）；secrets 走环境变量。
- systemd unit：`Type=simple`、`Restart=always`、`EnvironmentFile=/etc/knowbase/exporter.env`、`ExecStart=knowbase exporter --repo ... --space ...`。
- `deploy/exporter/README.md` + 主 README 章节，按顺序写清运营准备（spec §3.1/§3.2）：① 创建企业自建应用拿 App ID/Secret；② 开通 wiki/docx/drive 读权限并发布版本；③ **把应用 bot 加为知识库 space 成员**（最容易漏的一步，显著标出）；④ 准备空 git 仓库与推送凭据；⑤ 跑 `knowbase exporter --once` 冒烟验证（检查仓库里出现带 `feishu_url` frontmatter 的 md）；⑥ 常驻部署（Docker 或 systemd 二选一）；⑦ 成员侧无需任何操作，daemon 自动进入镜像模式。
- [ ] **Step 1: 写部署物与文档**
- [ ] **Step 2: `npm test && npm run build` 全量回归**
- [ ] **Step 3: 提交** — `git commit -m "docs(exporter): Dockerfile/systemd 部署示例与运营准备文档"`

---

## 计划外（明确不做，写进注释/文档即可）

- 图片/附件下载为仓库资产（v1 降级为原文链接占位；保持镜像仓库纯文本）。
- 飞书事件订阅准实时（v1 轮询，spec §10「不做实时」）。
- `migrate-to-lark`（计划 ③，另立）。
