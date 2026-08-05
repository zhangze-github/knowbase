# push 无权限熔断与只读降级 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让守护进程识别「重试必然失败」的 push（无权限 / 凭证失效 / 保护分支），从每 60 秒一次降为每 5 分钟一次静默探测，并把无写权限的成员降级为一个可用的只读模式。

**Architecture:** 三层。`git.ts` 新增纯函数 `classifyPushFailure` 把 push 失败分成 `denied` / `rejected` / `transient`；新文件 `push-gate.ts` 是一个持有熔断状态、时钟可注入的独立单元，只回答「现在该不该试 push」；`sync-engine.ts` 在第 5 步 push 前查询熔断器，commit / fetch / merge 三步完全不受影响。熔断状态活在守护进程内存里，不持久化。

**Tech Stack:** TypeScript (ESM, NodeNext)、Node ≥ 18、vitest。无新增依赖。

**规格:** [2026-08-05-push-denied-circuit-breaker-design.md](../specs/2026-08-05-push-denied-circuit-breaker-design.md)

## Global Constraints

- 所有面向用户的输出、日志、注释一律简体中文；标识符、git 输出关键词保持英文原文。
- 关键词匹配一律先 `.toLowerCase()` 再 `includes`，与现有 [git.ts](../../../src/git.ts) `push` / [status.ts](../../../src/commands/status.ts) 的写法一致。
- **`denied` 判定必须先于 `rejected`。** GitLab 拒保护分支时输出同时含两类关键词，顺序反了就退回无限重试——这是本次要修的核心 bug。
- 探测间隔固定 `5 * 60 * 1000` 毫秒，不做递增退避。
- 熔断只影响 push。任何任务都不得让 commit / fetch / merge 因熔断而跳过。
- 熔断期间的静默探测**不写日志**。日志只在状态翻转（进入熔断 / 恢复）时各写一条。
- `syncOnce` 永不抛异常的既有契约不变。
- 测试用命令：`npx vitest run <file>`（全量 `npm test`）。

---

### Task 1: push 失败分类与 locale 固定

**Files:**
- Modify: `src/git.ts`（`nonInteractiveEnv` 约第 11-21 行；`PushOutcome` / `push` 约第 215-237 行）
- Test: `test/push-classify.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `export type PushFailure = "denied" | "rejected" | "transient"`
  - `export function classifyPushFailure(output: string): PushFailure`
  - `export function pushFailureReason(r: GitResult): string`
  - `PushOutcome` 新增 `denied: boolean` 与 `failure?: PushFailure`
  - `export function pushDryRun(dir: string, remote: string, branch: string, timeoutMs?: number): PushOutcome`

- [ ] **Step 1: 写失败的测试**

新建 `test/push-classify.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { classifyPushFailure, pushFailureReason } from "../src/git.js";

describe("classifyPushFailure", () => {
  it("GitLab 保护分支：denied 优先于 rejected（同时含两类关键词）", () => {
    const out = [
      "remote: GitLab: You are not allowed to push code to this project.",
      "To https://gitlab.example.com/org/kb.git",
      " ! [remote rejected] HEAD -> main (pre-receive hook declined)",
      "error: failed to push some refs to 'https://gitlab.example.com/org/kb.git'",
    ].join("\n");
    expect(classifyPushFailure(out)).toBe("denied");
  });

  it("GitHub SSH 无写权限", () => {
    const out = [
      "ERROR: Permission to org/kb.git denied to alice.",
      "fatal: Could not read from remote repository.",
    ].join("\n");
    expect(classifyPushFailure(out)).toBe("denied");
  });

  it("SSH key 未配置", () => {
    const out = [
      "git@gitlab.example.com: Permission denied (publickey).",
      "fatal: Could not read from remote repository.",
    ].join("\n");
    expect(classifyPushFailure(out)).toBe("denied");
  });

  it("HTTPS 无凭证（terminal prompts disabled）", () => {
    const out =
      "fatal: could not read Username for 'https://gitlab.example.com': terminal prompts disabled";
    expect(classifyPushFailure(out)).toBe("denied");
  });

  it("HTTPS 403", () => {
    const out =
      "fatal: unable to access 'https://gitlab.example.com/org/kb.git/': The requested URL returned error: 403";
    expect(classifyPushFailure(out)).toBe("denied");
  });

  it("HTTPS 凭证失效", () => {
    expect(classifyPushFailure("remote: HTTP Basic: Access denied")).toBe("denied");
    expect(classifyPushFailure("fatal: Authentication failed for 'https://x/'")).toBe("denied");
  });

  it("GitHub 对无权限私有库返回伪装 404", () => {
    expect(classifyPushFailure("remote: Repository not found.")).toBe("denied");
  });

  it("并发竞争的 non-fast-forward 是 rejected，不是 denied", () => {
    const out = [
      "To /tmp/origin.git",
      " ! [rejected]        HEAD -> main (fetch first)",
      "error: failed to push some refs to '/tmp/origin.git'",
      "hint: Updates were rejected because the remote contains work that you do not have locally.",
    ].join("\n");
    expect(classifyPushFailure(out)).toBe("rejected");
  });

  it("网络类失败既非 denied 也非 rejected", () => {
    const out =
      "fatal: unable to access 'https://gitlab.example.com/org/kb.git/': Could not resolve host: gitlab.example.com";
    expect(classifyPushFailure(out)).toBe("transient");
  });

  it("不把成功输出里的 delta 数字误判成 HTTP 403", () => {
    // 只有失败才会调用分类，但输出里带 403/401 数字的情况必须不误伤
    expect(classifyPushFailure("Total 12 (delta 403), reused 0")).toBe("transient");
  });
});

describe("pushFailureReason", () => {
  it("优先取服务端 remote: 原文并去掉前缀", () => {
    const r = {
      code: 1,
      stdout: "",
      stderr: [
        "remote: GitLab: You are not allowed to push code to this project.",
        "error: failed to push some refs",
      ].join("\n"),
    };
    expect(pushFailureReason(r)).toBe(
      "GitLab: You are not allowed to push code to this project."
    );
  });

  it("无 remote: 行时退回第一条 fatal/error", () => {
    const r = {
      code: 1,
      stdout: "",
      stderr: "Cloning...\nfatal: Could not read from remote repository.\n",
    };
    expect(pushFailureReason(r)).toBe("fatal: Could not read from remote repository.");
  });

  it("空输出有兜底文案", () => {
    expect(pushFailureReason({ code: 1, stdout: "", stderr: "" })).toBe("未知原因");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/push-classify.test.ts`
Expected: FAIL，报 `classifyPushFailure` / `pushFailureReason` 不是 `src/git.ts` 的导出。

- [ ] **Step 3: 实现分类与 reason 提取**

在 `src/git.ts` 中，把现有的 `PushOutcome` / `push` 整段（约 215-237 行）替换为：

```ts
/** push 失败的语义分类。 */
export type PushFailure = "denied" | "rejected" | "transient";

/**
 * 「重试必然同样失败」的关键词：凭证、权限、服务端策略。
 * 刻意不用裸 "403" / "401"——push 输出里的 delta 计数可能恰好是这些数字。
 */
const DENIED_PATTERNS = [
  "permission denied",
  "denied to",
  "access denied",
  "authentication failed",
  "could not read username",
  "could not read password",
  "terminal prompts disabled",
  "returned error: 403",
  "returned error: 401",
  "forbidden",
  "unauthorized",
  "you are not allowed to push",
  "pre-receive hook declined",
  "protected branch",
  "repository not found",
];

/** 并发竞争导致的 non-fast-forward：下一周期先合并再推即可。 */
const REJECTED_PATTERNS = [
  "rejected",
  "non-fast-forward",
  "fetch first",
  "failed to push some refs",
];

/**
 * 对 push 的失败输出分类。
 *
 * denied 必须先于 rejected 判定：GitLab 拒保护分支时输出同时含
 * "not allowed to push"（永久失败）与 "[remote rejected]"（看起来像并发竞争），
 * 顺序反了会把永久失败误当成竞争，退回每周期无限重试。
 */
export function classifyPushFailure(output: string): PushFailure {
  const text = output.toLowerCase();
  if (DENIED_PATTERNS.some((p) => text.includes(p))) return "denied";
  if (REJECTED_PATTERNS.some((p) => text.includes(p))) return "rejected";
  return "transient";
}

/** 从 git 输出里挑一行最能说明问题的作为原因，优先服务端 remote: 原文。 */
export function pushFailureReason(r: GitResult): string {
  const lines = (r.stderr + "\n" + r.stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const remote = lines.find((l) => l.toLowerCase().startsWith("remote:"));
  if (remote) return remote.replace(/^remote:\s*/i, "");
  const fatal = lines.find((l) => /^(fatal|error):/i.test(l));
  return fatal ?? lines[0] ?? "未知原因";
}

export interface PushOutcome {
  ok: boolean;
  /** 被拒（并发竞争 / non-fast-forward），下一周期先合并再推。 */
  rejected: boolean;
  /** 凭证 / 权限 / 服务端策略拒绝——重试必然同样失败，交由熔断器处理。 */
  denied: boolean;
  failure?: PushFailure;
  result: GitResult;
}

function runPush(
  dir: string,
  remote: string,
  branch: string,
  timeoutMs: number,
  dryRun: boolean
): PushOutcome {
  const args = dryRun
    ? ["push", "--dry-run", remote, `HEAD:${branch}`]
    : ["push", remote, `HEAD:${branch}`];
  const r = git(args, { cwd: dir, timeoutMs });
  if (r.code === 0) return { ok: true, rejected: false, denied: false, result: r };
  const failure = classifyPushFailure(r.stderr + r.stdout);
  return {
    ok: false,
    rejected: failure === "rejected",
    denied: failure === "denied",
    failure,
    result: r,
  };
}

export function push(
  dir: string,
  remote: string,
  branch: string,
  timeoutMs = 60000
): PushOutcome {
  return runPush(dir, remote, branch, timeoutMs, false);
}

/**
 * 只做写权限探测：不传输对象，但仍会向服务端发起 receive-pack 协商，
 * 鉴权在该阶段发生，因此即使本地无新提交也能真实反映写权限。
 */
export function pushDryRun(
  dir: string,
  remote: string,
  branch: string,
  timeoutMs = 30000
): PushOutcome {
  return runPush(dir, remote, branch, timeoutMs, true);
}
```

- [ ] **Step 4: 固定 locale**

在 `src/git.ts` 的 `nonInteractiveEnv()` 里，`GIT_PAGER: "cat"` 那一行之后加：

```ts
    // 固定 locale：git 自身的错误文案在中文环境下会被本地化，
    // 会让 classifyPushFailure 的英文关键词全部失配。
    LC_ALL: "C",
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/push-classify.test.ts`
Expected: PASS（13 个用例全绿）

- [ ] **Step 6: 跑全量回归**

Run: `npm run build && npm test`
Expected: 全绿。既有测试只用到 `p.ok` / `p.rejected`，新增字段向后兼容。

> 每次跑全量都要**先 build**：`test/cli.test.ts` 执行的是编译产物 `dist/cli.js`，不 build 就是在测旧代码。

- [ ] **Step 7: 提交**

```bash
git add src/git.ts test/push-classify.test.ts
git commit -m "feat(git): push 失败分类（denied/rejected/transient）并固定 LC_ALL"
```

---

### Task 2: 熔断器 PushGate

**Files:**
- Create: `src/push-gate.ts`
- Modify: `src/config.ts`（在 `DaemonState` 之前新增 `PushBlocked`，并给 `DaemonState` 加字段）
- Test: `test/push-gate.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `PushOutcome`（只用到 `ok` / `denied` 两个字段）
- Produces:
  - `src/config.ts`：`export interface PushBlocked { since: string; reason: string; nextProbeAt: string }`，`DaemonState.pushBlocked?: PushBlocked`
  - `src/push-gate.ts`：`export const PROBE_INTERVAL_MS = 5 * 60 * 1000`
  - `export class PushGate`，方法 `shouldAttempt(now: number): boolean`、`record(outcome: { ok: boolean; denied: boolean }, reason: string, now: number): "blocked" | "recovered" | "unchanged"`、`snapshot(): PushBlocked | undefined`、getter `blocked: boolean`

`now` 一律是毫秒时间戳（`Date.now()` 语义），不是 `Date` 对象。

- [ ] **Step 1: 写失败的测试**

新建 `test/push-gate.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { PushGate, PROBE_INTERVAL_MS } from "../src/push-gate.js";

const T0 = 1_800_000_000_000; // 固定基准时刻，避免依赖真实时钟
const DENIED = { ok: false, denied: true };
const OK = { ok: true, denied: false };
const TRANSIENT = { ok: false, denied: false };

describe("PushGate", () => {
  it("未熔断时一律放行", () => {
    const gate = new PushGate();
    expect(gate.shouldAttempt(T0)).toBe(true);
    expect(gate.blocked).toBe(false);
    expect(gate.snapshot()).toBeUndefined();
  });

  it("首次 denied 立即熔断并报告状态翻转", () => {
    const gate = new PushGate();
    expect(gate.record(DENIED, "no write access", T0)).toBe("blocked");
    expect(gate.blocked).toBe(true);
  });

  it("熔断后在窗口内不放行，到点放行一次", () => {
    const gate = new PushGate();
    gate.record(DENIED, "no write access", T0);
    expect(gate.shouldAttempt(T0 + PROBE_INTERVAL_MS - 1000)).toBe(false);
    expect(gate.shouldAttempt(T0 + PROBE_INTERVAL_MS)).toBe(true);
    expect(gate.shouldAttempt(T0 + PROBE_INTERVAL_MS + 1000)).toBe(true);
  });

  it("探测再次 denied 则窗口顺延，且不再报翻转（避免重复写日志）", () => {
    const gate = new PushGate();
    gate.record(DENIED, "no write access", T0);
    const probeAt = T0 + PROBE_INTERVAL_MS;
    expect(gate.record(DENIED, "no write access", probeAt)).toBe("unchanged");
    expect(gate.shouldAttempt(probeAt + 1000)).toBe(false);
    expect(gate.shouldAttempt(probeAt + PROBE_INTERVAL_MS)).toBe(true);
  });

  it("熔断期间探测因网络失败也顺延窗口，不退回每周期重试", () => {
    const gate = new PushGate();
    gate.record(DENIED, "no write access", T0);
    const probeAt = T0 + PROBE_INTERVAL_MS;
    expect(gate.record(TRANSIENT, "could not resolve host", probeAt)).toBe("unchanged");
    expect(gate.shouldAttempt(probeAt + 1000)).toBe(false);
    expect(gate.blocked).toBe(true);
  });

  it("未熔断时的网络失败不触发熔断", () => {
    const gate = new PushGate();
    expect(gate.record(TRANSIENT, "could not resolve host", T0)).toBe("unchanged");
    expect(gate.blocked).toBe(false);
    expect(gate.shouldAttempt(T0)).toBe(true);
  });

  it("push 成功即解除熔断并报告恢复", () => {
    const gate = new PushGate();
    gate.record(DENIED, "no write access", T0);
    expect(gate.record(OK, "", T0 + PROBE_INTERVAL_MS)).toBe("recovered");
    expect(gate.blocked).toBe(false);
    expect(gate.snapshot()).toBeUndefined();
    expect(gate.shouldAttempt(T0 + PROBE_INTERVAL_MS)).toBe(true);
  });

  it("未熔断时的成功不报恢复", () => {
    const gate = new PushGate();
    expect(gate.record(OK, "", T0)).toBe("unchanged");
  });

  it("snapshot 输出 ISO 时间与原因，供 status 展示", () => {
    const gate = new PushGate();
    gate.record(DENIED, "GitLab: You are not allowed to push code to this project.", T0);
    const snap = gate.snapshot();
    expect(snap).toEqual({
      since: new Date(T0).toISOString(),
      reason: "GitLab: You are not allowed to push code to this project.",
      nextProbeAt: new Date(T0 + PROBE_INTERVAL_MS).toISOString(),
    });
  });

  it("熔断持续期间 since 保持首次时刻不变", () => {
    const gate = new PushGate();
    gate.record(DENIED, "a", T0);
    gate.record(DENIED, "b", T0 + PROBE_INTERVAL_MS);
    expect(gate.snapshot()!.since).toBe(new Date(T0).toISOString());
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/push-gate.test.ts`
Expected: FAIL，报找不到模块 `../src/push-gate.js`。

- [ ] **Step 3: 在 config.ts 加状态类型**

在 `src/config.ts` 中 `export interface DaemonState {` 这一行**之前**插入：

```ts
/** push 熔断状态快照（写入 DaemonState 供 status 展示）。 */
export interface PushBlocked {
  /** 首次判定无权限的时刻（ISO）。 */
  since: string;
  /** 服务端给出的原因原文（单行）。 */
  reason: string;
  /** 下一次自动探测的时刻（ISO）。 */
  nextProbeAt: string;
}
```

并在 `DaemonState` 里 `paused?: boolean;` 之后加：

```ts
  /** 无 push 权限而熔断时存在；恢复后清空。 */
  pushBlocked?: PushBlocked;
```

- [ ] **Step 4: 实现 PushGate**

新建 `src/push-gate.ts`：

```ts
import type { PushBlocked } from "./config.js";

/** 熔断期间的探测间隔：固定 5 分钟，不做递增退避。 */
export const PROBE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * push 熔断器。
 *
 * 把「重试必然失败」的 push（无写权限 / 凭证失效 / 保护分支）从每个同步周期
 * 一次降到每 5 分钟一次静默探测，权限补上后自动解除。
 *
 * 只掐 push：commit / fetch / merge 不受影响，无写权限的成员因此降级为一个
 * 可用的只读模式——本地改动仍安全提交在本机，团队更新照常拉取。
 *
 * 状态只活在守护进程内存里，不持久化：重启后先试一次再熔断，代价是一次多余
 * 请求，换来无需维护状态文件、也无需处理其损坏。因此前台 `knowbase sync`
 * （另一个进程、不持有熔断器）天然无视熔断，正是想要的行为。
 */
export class PushGate {
  private blockedSince: number | null = null;
  private reason = "";
  private nextProbeAt = 0;

  get blocked(): boolean {
    return this.blockedSince !== null;
  }

  /** 本轮是否应该尝试 push。熔断中仅在探测窗口到点时放行一次。 */
  shouldAttempt(now: number): boolean {
    if (this.blockedSince === null) return true;
    return now >= this.nextProbeAt;
  }

  /**
   * 回喂一次 push 结果。返回状态是否翻转，调用方据此决定要不要写日志——
   * 静默探测必须不写日志，否则噪声与修复前无异。
   */
  record(
    outcome: { ok: boolean; denied: boolean },
    reason: string,
    now: number
  ): "blocked" | "recovered" | "unchanged" {
    if (outcome.ok) {
      if (this.blockedSince === null) return "unchanged";
      this.blockedSince = null;
      this.reason = "";
      this.nextProbeAt = 0;
      return "recovered";
    }
    if (outcome.denied) {
      const first = this.blockedSince === null;
      if (first) this.blockedSince = now;
      this.reason = reason;
      this.nextProbeAt = now + PROBE_INTERVAL_MS;
      return first ? "blocked" : "unchanged";
    }
    // 非 denied 失败：未熔断时交回原有的下周期重试逻辑，不熔断；
    // 熔断中则同样顺延窗口——否则窗口不前移，下一周期立刻又试，退回每 60 秒一次。
    if (this.blockedSince !== null) this.nextProbeAt = now + PROBE_INTERVAL_MS;
    return "unchanged";
  }

  snapshot(): PushBlocked | undefined {
    if (this.blockedSince === null) return undefined;
    return {
      since: new Date(this.blockedSince).toISOString(),
      reason: this.reason,
      nextProbeAt: new Date(this.nextProbeAt).toISOString(),
    };
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/push-gate.test.ts`
Expected: PASS（10 个用例全绿）

- [ ] **Step 6: 类型检查**

Run: `npm run build`
Expected: 无输出、退出码 0。

- [ ] **Step 7: 提交**

```bash
git add src/push-gate.ts src/config.ts test/push-gate.test.ts
git commit -m "feat(push-gate): 新增 push 熔断器（固定 5 分钟探测）"
```

---

### Task 3: syncOnce 接入熔断

**Files:**
- Modify: `src/sync-engine.ts`（`SyncDeps` 约 18-24 行、`SyncResult` 约 26-36 行、`emptyResult` 约 40-49 行、第 5 步 push 约 198-215 行）
- Modify: `test/helpers.ts`（新增 `denyPush` / `allowPush`）
- Test: `test/sync-engine.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: Task 1 的 `git.push` / `git.pushFailureReason`；Task 2 的 `PushGate`
- Produces:
  - `SyncDeps.pushGate?: PushGate`
  - `SyncResult.pushDenied: boolean`、`SyncResult.pushSkipped: boolean`
  - `test/helpers.ts`：`export function denyPush(bare: string, message?: string): void`、`export function allowPush(bare: string): void`

- [ ] **Step 1: 加测试辅助**

在 `test/helpers.ts` 末尾追加：

```ts
/**
 * 给 bare 远端装一个 pre-receive 钩子，真实模拟「有读权限、无写权限」。
 * git 会给钩子的 stderr 加上 remote: 前缀，输出形态与 GitLab 线上一致。
 */
export function denyPush(
  bare: string,
  message = "GitLab: You are not allowed to push code to this project."
): void {
  const hook = path.join(bare, "hooks", "pre-receive");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\necho "${message}" >&2\nexit 1\n`);
  fs.chmodSync(hook, 0o755);
}

/** 摘掉拒绝钩子，模拟管理员补上了写权限。 */
export function allowPush(bare: string): void {
  fs.rmSync(path.join(bare, "hooks", "pre-receive"), { force: true });
}
```

- [ ] **Step 2: 写失败的测试**

在 `test/sync-engine.test.ts` 的 import 块里，把 `g` 那一行改为同时引入新辅助：

```ts
  g,
  denyPush,
  allowPush,
```

并在 `src/push-gate.js` / `PROBE_INTERVAL_MS` 上补一条 import：

```ts
import { PushGate, PROBE_INTERVAL_MS } from "../src/push-gate.js";
```

在文件末尾追加：

```ts
describe("push 无权限熔断", () => {
  /** 造一个「本地有改动待推、远端拒绝写入」的场景。 */
  function setup(): { kb: string; cfg: ReturnType<typeof mkConfig> } {
    const kb = path.join(root, "kb");
    cloneWorkdir(bare, kb);
    denyPush(bare);
    write(kb, "a.md", "hello\n");
    return { kb, cfg: mkConfig(bare, kb) };
  }

  const at = (ms: number) => ({
    logger,
    hostname: "hostX",
    now: () => new Date(ms),
  });

  const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);

  it("判定为 denied 而不是并发竞争", () => {
    const { cfg } = setup();
    const gate = new PushGate();
    const r = syncOnce(cfg, { ...at(T0), pushGate: gate });
    expect(r.pushDenied).toBe(true);
    expect(r.pushRejected).toBe(false);
    expect(r.pushed).toBe(false);
    expect(gate.blocked).toBe(true);
  });

  it("熔断后连跑多轮只尝试一次 push", () => {
    const { kb, cfg } = setup();
    const gate = new PushGate();
    syncOnce(cfg, { ...at(T0), pushGate: gate });

    for (let i = 1; i <= 5; i++) {
      write(kb, `b${i}.md`, "x\n");
      const r = syncOnce(cfg, { ...at(T0 + i * 60_000), pushGate: gate });
      expect(r.pushSkipped).toBe(true);
      expect(r.pushed).toBe(false);
      // 关键：熔断只掐 push，本地提交必须照常发生
      expect(r.committed).toBe(true);
    }
  });

  it("熔断期间日志里该错误只出现一次", () => {
    const { kb, cfg } = setup();
    const gate = new PushGate();
    syncOnce(cfg, { ...at(T0), pushGate: gate });
    for (let i = 1; i <= 5; i++) {
      write(kb, `b${i}.md`, "x\n");
      syncOnce(cfg, { ...at(T0 + i * 60_000), pushGate: gate });
    }
    const log = fs.readFileSync(logger.path(), "utf8");
    const hits = log.split("\n").filter((l) => l.includes("push 无权限"));
    expect(hits).toHaveLength(1);
  });

  it("窗口到点会再探测一次", () => {
    const { cfg } = setup();
    const gate = new PushGate();
    syncOnce(cfg, { ...at(T0), pushGate: gate });
    const r = syncOnce(cfg, { ...at(T0 + PROBE_INTERVAL_MS), pushGate: gate });
    expect(r.pushSkipped).toBe(false);
    expect(r.pushDenied).toBe(true);
  });

  it("熔断期间仍能合并远端改动（只读模式可用）", () => {
    const { kb, cfg } = setup();
    const gate = new PushGate();
    syncOnce(cfg, { ...at(T0), pushGate: gate });

    // 另一台设备推了内容到远端（绕过钩子：直接改 bare 的另一个 clone 再 push 会被拦，
    // 所以先摘钩子推完再装回去）
    allowPush(bare);
    const other = path.join(root, "other");
    cloneWorkdir(bare, other);
    write(other, "from-team.md", "team\n");
    g(other, "add", "-A");
    g(other, "commit", "-m", "team change");
    g(other, "push", "origin", "HEAD:main");
    denyPush(bare);

    const r = syncOnce(cfg, { ...at(T0 + 60_000), pushGate: gate });
    expect(r.merged).toBe(true);
    expect(r.pushSkipped).toBe(true);
    expect(read(kb, "from-team.md")).toBe("team\n");
  });

  it("权限恢复后自动继续推送并写一条恢复日志", () => {
    const { cfg } = setup();
    const gate = new PushGate();
    syncOnce(cfg, { ...at(T0), pushGate: gate });
    expect(gate.blocked).toBe(true);

    allowPush(bare);
    const r = syncOnce(cfg, { ...at(T0 + PROBE_INTERVAL_MS), pushGate: gate });
    expect(r.pushed).toBe(true);
    expect(gate.blocked).toBe(false);
    expect(fs.readFileSync(logger.path(), "utf8")).toContain("push 权限已恢复");
  });

  it("不传 pushGate 时不熔断（前台 knowbase sync 的行为）", () => {
    const { kb, cfg } = setup();
    const r1 = syncOnce(cfg, at(T0));
    expect(r1.pushDenied).toBe(true);
    write(kb, "c.md", "x\n");
    const r2 = syncOnce(cfg, at(T0 + 1000));
    expect(r2.pushSkipped).toBe(false);
    expect(r2.pushDenied).toBe(true);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run test/sync-engine.test.ts -t "push 无权限熔断"`
Expected: FAIL —— `r.pushDenied` / `r.pushSkipped` 为 `undefined`，且 `SyncDeps` 不接受 `pushGate`（tsc 报错或运行期断言失败）。

- [ ] **Step 4: 扩展 SyncDeps / SyncResult**

在 `src/sync-engine.ts` 顶部 import 区加：

```ts
import { PushGate } from "./push-gate.js";
```

`SyncDeps` 里 `hostname?: string;` 之后加：

```ts
  /**
   * push 熔断器（守护进程长驻持有）。不传即不熔断——前台单次同步走这条路，
   * 用户主动跑 `knowbase sync` 就是想立刻知道现在通不通。
   */
  pushGate?: PushGate;
```

`SyncResult` 里 `pushRejected: boolean;` 之后加：

```ts
  /** push 因权限/凭证被拒（重试无意义）。 */
  pushDenied: boolean;
  /** 因熔断跳过了本轮 push。 */
  pushSkipped: boolean;
```

`emptyResult()` 的返回对象里 `pushRejected: false,` 之后加：

```ts
    pushDenied: false,
    pushSkipped: false,
```

- [ ] **Step 5: 改写第 5 步 push**

把 `src/sync-engine.ts` 中 `if (shouldPush) { ... }` 整块（约 203-215 行）替换为：

```ts
    if (shouldPush) {
      const gate = deps.pushGate;
      const nowMs = (deps.now ? deps.now() : new Date()).getTime();
      if (gate && !gate.shouldAttempt(nowMs)) {
        // 熔断中且未到探测窗口：静默跳过。这里刻意不写日志——
        // 每周期一条错误日志本身就是本次要修的问题之一。
        result.pushSkipped = true;
      } else {
        const p = git.push(dir, REMOTE, cfg.branch);
        result.pushed = p.ok;
        result.pushRejected = p.rejected;
        result.pushDenied = p.denied;
        const reason = p.ok ? "" : git.pushFailureReason(p.result);
        const flip = gate?.record(p, reason, nowMs) ?? "unchanged";
        if (p.ok) {
          logger.log(flip === "recovered" ? "push 权限已恢复，继续推送" : "已推送到远端");
        } else if (p.denied) {
          result.error = `push 无权限：${reason}`;
          if (flip === "blocked" || !gate) {
            logger.log(`push 无权限，已暂停推送（每 5 分钟自动重试一次）：${reason}`);
          }
        } else if (p.rejected) {
          logger.log("push 被拒（并发竞争），下一周期先合并再推");
        } else {
          result.error = `push 失败：${(p.result.stderr || p.result.stdout).trim()}`;
          logger.log(result.error + "（下一周期重试）");
        }
      }
    }
```

`|| !gate` 是为了让前台 `knowbase sync` 也把原因写进日志（它没有熔断器，`flip` 恒为 `"unchanged"`）。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run test/sync-engine.test.ts`
Expected: PASS，新增 7 个用例全绿，既有用例不回归。

- [ ] **Step 7: 跑全量并类型检查**

Run: `npm run build && npm test`
Expected: tsc 无报错、测试全绿。

- [ ] **Step 8: 提交**

```bash
git add src/sync-engine.ts test/helpers.ts test/sync-engine.test.ts
git commit -m "feat(sync): push 无权限时熔断，只读模式下仍正常 commit/fetch/merge"
```

---

### Task 4: 守护进程写状态 + status 展示

**Files:**
- Modify: `src/sync-engine.ts`（`runDaemon` 约 289-330 行）
- Modify: `src/commands/status.ts`（在「本地领先远端」输出之后插入）
- Test: `test/cli.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `PushGate` / `PushBlocked`；Task 3 的 `SyncResult.pushDenied`
- Produces: `DaemonState.pushBlocked` 被守护进程写入；`status` 输出含「无 push 权限」段落且退出码为 1

- [ ] **Step 1: 让 runDaemon 持有熔断器并落盘状态**

在 `src/sync-engine.ts` 的 `runDaemon` 中，`writeDaemonState(state);` 之后、`const runCycle` 之前插入：

```ts
  // 熔断器长驻于守护进程内存：跨周期保持状态，随进程退出而清空。
  const gate = deps.pushGate ?? new PushGate();
  const cycleDeps: SyncDeps = { ...deps, pushGate: gate };
```

把 `runCycle` 里的 `const r = syncOnce(cfg, deps);` 改为：

```ts
      const r = syncOnce(cfg, cycleDeps);
```

并在同一个 `try` 块内、`writeDaemonState(state);` 之前插入：

```ts
      state.pushBlocked = gate.snapshot();
```

- [ ] **Step 2: 写失败的测试**

在 `test/cli.test.ts` **末尾**（现有 `describe` 块之外）追加一个新的顶层 `describe`。注意该文件的既有约定：`knowbase(args)` 返回 `{ code, out }`（`out` 已经是 stdout + stderr 拼好的，**没有** `stdout` / `stderr` 字段）；`kb` 不是共享变量，每个用例自己 `const kb = path.join(root, "kb")`；`home` 是 `beforeEach` 里设好的临时 HOME，且 `XDG_CONFIG_HOME` 已指向 `${home}/.config`。

```ts
describe("status 展示 push 熔断", () => {
  it("pushBlocked 存在时给出只读模式提示并以非零退出", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb, "--no-agent-config"]).code).toBe(0);

    // status 只读状态文件，不需要真跑守护进程；直接构造一份。
    // 测试里 KNOWBASE_SKIP_AUTOSTART=1，init 不会产生 daemon.state.json，所以是新建。
    // pid 用当前进程（确实存活）→ status 判定「运行中」，避免多出一条无关 anomaly，
    // 让退出码 1 只由 pushBlocked 贡献。
    const statePath = path.join(home, ".config", "knowbase", "daemon.state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date(Date.UTC(2026, 7, 5, 11, 0, 0)).toISOString(),
          pushBlocked: {
            since: new Date(Date.UTC(2026, 7, 5, 12, 0, 0)).toISOString(),
            reason: "GitLab: You are not allowed to push code to this project.",
            nextProbeAt: new Date(Date.UTC(2026, 7, 5, 12, 5, 0)).toISOString(),
          },
        },
        null,
        2
      )
    );

    const r = knowbase(["status"]);
    expect(r.out).toContain("无 push 权限");
    expect(r.out).toContain("You are not allowed to push code to this project.");
    expect(r.out).toContain("无需手动操作");
    expect(r.code).toBe(1);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

`cli.test.ts` 跑的是编译产物 `dist/cli.js`，必须先 build：

Run: `npm run build && npx vitest run test/cli.test.ts -t "status 展示 push 熔断"`
Expected: FAIL —— 输出不含「无 push 权限」。

- [ ] **Step 4: 在 status 里展示**

在 `src/commands/status.ts` 中，`console.log(\`本地领先远端：  ${ahead} 个提交（未推送，以上次 fetch 为准）\`);` 之后插入：

```ts
  // push 熔断（无写权限）——必须醒目：用户看到的「本地领先 N 个提交」
  // 在这种状态下意味着这些提交永远推不出去。
  if (state?.pushBlocked) {
    const pb = state.pushBlocked;
    console.log("");
    console.log(`⚠ 无 push 权限：本地 ${ahead} 个提交只在本机，未同步给团队。`);
    console.log(`  原因：${pb.reason}`);
    console.log(
      `  下次自动重试：${new Date(pb.nextProbeAt).toLocaleString()}。` +
        `补上权限后会自动恢复，无需手动操作。`
    );
    anomalies.push(
      `无 push 权限，${ahead} 个提交未推送给团队——请联系仓库管理员补上写权限，之后自动恢复。`
    );
  }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run build && npx vitest run test/cli.test.ts`
Expected: PASS

- [ ] **Step 6: 跑全量**

Run: `npm run build && npm test`
Expected: 全绿。（顺序很重要：`cli.test.ts` 跑 `dist/cli.js`，先 build 再测。）

- [ ] **Step 7: 提交**

```bash
git add src/sync-engine.ts src/commands/status.ts test/cli.test.ts
git commit -m "feat(status): 展示 push 熔断状态与只读模式提示"
```

---

### Task 5: init 写权限预检

**Files:**
- Modify: `src/commands/init.ts`（分支切换之后、种规则之前插入预检；并改写种规则那段的 push 失败提示）
- Test: `test/cli.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `git.pushDryRun` / `git.pushFailureReason`
- Produces: 无（仅 CLI 输出行为变化）

- [ ] **Step 1: 写失败的测试**

先把 `test/cli.test.ts` 顶部的 helpers import 改为：

```ts
import { tmpDir, makeOrigin, g, denyPush } from "./helpers.js";
```

（`g` 目前已被既有用例使用，保留。）然后在文件末尾追加：

```ts
describe("init 写权限预检", () => {
  it("无 push 权限时警告只读模式但不阻断接入", () => {
    const kb = path.join(root, "kb");
    denyPush(bare);
    const r = knowbase(["init", bare, "--dir", kb, "--no-agent-config"]);
    expect(r.code).toBe(0); // 不阻断
    expect(r.out).toContain("只读模式");
    expect(r.out).toContain("无需重新 init");
    expect(r.out).not.toContain("守护进程会自动重试");
    // 配置照常写入，接入流程走完
    expect(fs.existsSync(path.join(home, ".config", "knowbase", "config.json"))).toBe(true);
  });

  it("有权限时不出现只读模式警告", () => {
    const kb = path.join(root, "kb");
    const r = knowbase(["init", bare, "--dir", kb, "--no-agent-config"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("只读模式");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && npx vitest run test/cli.test.ts -t "init 写权限预检"`
Expected: FAIL —— 输出不含「只读模式」。

- [ ] **Step 3: 插入预检**

在 `src/commands/init.ts` 中，分支切换那段（`if (headBorn && git.currentBranch(dir) !== branch) { ... }`）之后、`// 3. 种入 union 合并规则与忽略规则` 之前插入：

```ts
  // 2.5 写权限预检。ls-remote 只验证读权限——只读成员会一路成功接入，
  // 然后每个周期默默推不上去。这里提前把事实说清楚，但不阻断：
  // 只读同样是合法用法（能读到团队知识就已经有价值）。
  let readOnly = false;
  if (headBorn) {
    const dry = git.pushDryRun(dir, "origin", branch);
    readOnly = dry.denied;
    if (readOnly) {
      console.warn("");
      console.warn("⚠ 你对该仓库没有 push 权限，knowbase 将以只读模式运行：");
      console.warn("  能拉到团队的更新，本地改动只提交在本机、不会同步出去。");
      console.warn(`  原因：${git.pushFailureReason(dry.result)}`);
      console.warn("  需要写权限请联系仓库管理员，补上后自动恢复，无需重新 init。");
      console.warn("");
    }
  }
```

`headBorn` 守卫的原因：空仓库（远端全新、HEAD 未诞生）上 `push --dry-run HEAD:<branch>` 会因 `HEAD` 无法解析而失败，那不是权限问题；跳过预检即可，`readOnly` 保持 `false`。

- [ ] **Step 4: 改写种规则时的 push 失败提示**

把种规则那段里的：

```ts
      const p = git.push(dir, "origin", branch);
      if (!p.ok) {
        console.warn("⚠ 规则已本地提交，但推送未成功（守护进程会自动重试）。");
      }
```

替换为：

```ts
      if (readOnly) {
        console.log("  （只读模式：规则已本地提交，暂不推送）");
      } else {
        const p = git.push(dir, "origin", branch);
        if (!p.ok) {
          console.warn(
            p.denied
              ? "⚠ 规则已本地提交，但没有 push 权限——将以只读模式运行，补上写权限后自动恢复。"
              : "⚠ 规则已本地提交，但推送未成功（守护进程会自动重试）。"
          );
        }
      }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run build && npx vitest run test/cli.test.ts`
Expected: PASS

- [ ] **Step 6: 跑全量**

Run: `npm run build && npm test`
Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
git add src/commands/init.ts test/cli.test.ts
git commit -m "feat(init): 预检写权限，无权限时提示只读模式但不阻断"
```

---

### Task 6: 文档

**Files:**
- Modify: `README.md`（「同步与冲突策略」小节之后新增一节）
- Modify: `package.json`（version → `0.5.0`）

**Interfaces:**
- Consumes: 前五个任务的最终行为
- Produces: 无

- [ ] **Step 1: 写 README 小节**

在 `README.md` 的「## 同步与冲突策略」小节末尾（「冲突副本兜底」那段之后）、「## 与 AI agent 集成（自动）」之前插入：

```markdown
## 没有写权限时：只读模式

不是每个成员都需要写权限。对该仓库只有读权限时，knowbase 自动降级为**只读模式**，而不是无限重试推送：

- `init` 会在接入时预检写权限，当场告知将以只读模式运行——**不阻断接入**。
- 守护进程识别出「权限 / 凭证 / 保护分支」这类重试必然失败的 push 后立即**熔断**，之后每 5 分钟静默探测一次，日志只在状态翻转时各记一条，不刷屏。
- **拉取侧完全不受影响**：团队的更新照常 fetch、merge 到本地；你的改动也照常提交在本机，不会丢。
- 管理员补上写权限后，下一次探测成功即自动恢复推送，积压的提交一次推完，**无需重新 init 或任何手动操作**。

`knowbase status` 会醒目地显示这个状态，包括原因原文和下次重试时间：

```
⚠ 无 push 权限：本地 3 个提交只在本机，未同步给团队。
  原因：GitLab: You are not allowed to push code to this project.
  下次自动重试：2026/8/5 14:35:00。补上权限后会自动恢复，无需手动操作。
```

网络抖动、并发竞争这类**可恢复**的失败不走熔断，仍按原策略在下个周期快速重试。
```

- [ ] **Step 2: 升版本号**

把 `package.json` 的 `"version"` 改为 `"0.5.0"`。

- [ ] **Step 3: 校对**

Run: `npm run build && npm test`
Expected: 全绿（文档改动不影响测试，此步是提交前的最后一道保险）。注意 `cli.test.ts` 有一条断言 `--version` 输出形如 `x.y.z`，改版本号不会破坏它。

- [ ] **Step 4: 提交**

```bash
git add README.md package.json
git commit -m "docs: 说明无写权限时的只读模式；0.5.0"
```

---

## 收尾验证

- [ ] `npm run build && npm test` 全绿（顺序不能反）
- [ ] 人工确认：`classifyPushFailure` 里 `DENIED_PATTERNS` 的判定确实在 `REJECTED_PATTERNS` 之前
- [ ] 人工确认：`sync-engine.ts` 的 `result.pushSkipped = true` 分支内没有任何 `logger.log` 调用
- [ ] 人工确认：`git.ts` 的 `nonInteractiveEnv()` 含 `LC_ALL: "C"`
