# 知识库索引自动注入 agent 提示词（v0.3.0）

> 前置：[knowbase 实现设计](2026-07-29-knowbase-design.md)。本文档描述在既有 agent-config 托管区块机制之上，把知识库根 `index.md` 自动注入 Claude Code / Codex 全局提示词的设计。

## 1. 问题

现有托管区块只告诉 agent「知识库在哪、怎么读写」，没告诉它**里面有什么**。实测结果是：除非用户主动要求「去读知识库」，agent 不会自发去 grep 一个它不知道内容的目录。知识库因此形同不存在。

## 2. 目标与非目标

**目标**：agent 在会话开始时就持有一份知识库内容地图（根 `index.md`），从而能自主判断「这个问题该去知识库找」。地图随知识库变化自动更新，用户零操作。

**非目标**：

- **不生成、不维护 index.md 内容**。各目录 `index.md` 由用户另行部署的索引维护 agent 负责。knowbase 只负责注入。
- **不在 init 时播种 `index.md`**。播种空壳会与索引维护 agent 抢文件所有权。
- **不注入子目录的 index.md**。只注根目录那一份；子目录索引靠区块中的导航约定让 agent 按需读取。

## 3. 机制选型

| 方案 | 结论 |
|---|---|
| Claude Code `SessionStart` hook（`additionalContext`） | 否决。Claude Code 独有，Codex 无对等的上下文注入 hook，会分裂成两套机制；且需要对 `~/.claude/settings.json` 做 JSON 合并，比 Markdown 区块更易破坏用户配置 |
| `CLAUDE.md` 的 `@path` 导入 | 否决。Claude 侧确实零过期、零体积，但 Codex `AGENTS.md` 不支持导入，仍需内嵌分支。用户选择牺牲这点换取两侧完全对称 |
| **托管区块内嵌全文（选定）** | 复用已有的 `upsertBlock` / `stripBlock` 幂等区块机制，一套代码覆盖所有「读全局 Markdown 提示词」的 agent，`uninstall` 无需改动 |

代价与接受理由：内容有过期窗口（依赖 daemon 刷新），且个人提示词文件体积随索引增长——用 8KB 上限封顶。

## 4. 区块内容

现有区块的「读 / 写 / 操作」三段不变，尾部新增两段：

```markdown
<!-- KNOWBASE:START （由 knowbase 自动管理，勿手动编辑本区块） -->
## 组织知识库（knowbase）

本机知识库位于：`<dir>`
...（现有 读 / 写 / 操作 三段，不动）...

**导航**：知识库每个目录下都有 `index.md` 作为该目录的索引。进入任一子目录查找前，
先读该目录的 `index.md`；在知识库中新增或删除文件后，顺手更新所在目录的 `index.md`。

### 知识库索引（根 index.md 快照，由 knowbase 自动同步）

<内嵌 <dir>/index.md 全文>
<!-- KNOWBASE:END -->
```

### 4.1 文件名大小写不敏感

索引文件按**大小写不敏感**方式查找：列出 `<dir>` 的条目，取文件名小写后等于 `index.md` 的那一个，因此 `index.md` / `Index.md` / `INDEX.md` 均被识别。

理由：macOS 的 APFS 默认大小写不敏感，Linux 大小写敏感。若按字面 `index.md` 查找，仓库里存在 `Index.md` 时会出现「macOS 上索引生效、Linux 上索引缺失」的跨平台不一致——同一个知识库在不同成员机器上行为不同，极难排查。

存在多个大小写变体时（只可能发生在大小写敏感的文件系统上）取值必须确定：优先精确匹配 `index.md`，否则取排序后的第一个。同时在日志中记录一次告警，提示仓库内存在重名变体。

### 4.2 索引缺失

未找到索引文件时不输出 `###` 索引段，代之一行：

> 根目录暂无 `index.md`，需要时直接 grep 全库。

理由：索引维护 agent 尚未跑起来时 `init` 不应报错，也不该留下空标题。

### 4.3 标记注入防护（必须）

索引全文由外部 agent 生成，内容可能包含 `KNOWBASE:START` / `KNOWBASE:END` 字样（例如索引里记录了 knowbase 自身的文档）。若原样内嵌，`upsertBlock` / `stripBlock` 会匹配到提前出现的结束标记、切错位置，吞掉用户 `CLAUDE.md` 中区块之后的内容。

内嵌前把索引正文中的 `KNOWBASE:START` / `KNOWBASE:END` 字样中和（替换为 `KNOWBASE_START` / `KNOWBASE_END`）。

### 4.4 体积上限

索引全文超过 **8192 字节**（约 2k token）时，在不超限的最后一个换行处截断，追加：

> …（索引过长已截断，完整内容见 `<dir>/index.md`）

理由：索引长起来会静默吃掉每次会话的上下文预算，必须有硬上限。

### 4.5 标题层级不降级

索引中的 `#` / `##` 原样内嵌，不改写为 `###`。正确降级需要区分代码块内外的 `#`，复杂度不划算；提示词中的层级错乱不影响 agent 理解。

## 5. 刷新机制

### 5.1 一个函数，两个调用方

`installAgentConfig` 改名为 `syncAgentConfig(dir, home?)`，职责：

```
定位索引文件（大小写不敏感）→ 读取 → 中和标记 → 超限截断
  → buildBlock(dir, index)
  → 对每个 target: upsertBlock；内容与现状相同则不落盘
  → 返回 AgentConfigChange[]
```

- `init` 调用后逐条打印（行为不变）
- `sync-engine.ts` 的 `runCycle` 末尾调用，仅在有 target 实际变更时写一行日志

`runCycle` 是唯一挂载点：watcher 触发与轮询触发都经过它，一处埋点同时覆盖「本地索引被改」和「远端拉来新索引」两个来源。

### 5.2 新增配置字段 `agentConfig`

`Config` 增加 `agentConfig?: boolean`，`loadConfig` 默认 `true`；`init --no-agent-config` 时持久化为 `false`，`runCycle` 据此决定是否刷新。

这是修 bug 性质的改动：现在 `--no-agent-config` 只是 init 时的一次性跳过，没有持久化。daemon 若无条件刷新，会把用户明确拒绝过的区块悄悄加回去。

### 5.3 原子写入

对 agent 提示词文件的写入改为「同目录临时文件 + `renameSync`」。一次性 init 时直写无所谓，但改为每 60 秒可能触发的周期性写入后，进程在错误时机被 kill 会留下截断的 `~/.claude/CLAUDE.md`——那是用户的个人文件，损坏代价高。

### 5.4 失败隔离

刷新整体包在 `try/catch` 内，出错只记日志：不影响同步结果、不改变 `DaemonState`、绝不让 daemon 退出。与既有「日志失败不能拖垮守护进程」一致。

### 5.5 paused 状态照常刷新

刷新是纯本地读 + 写提示词文件，不碰 git，不存在「半成品被提交」的风险，因此不受 `.knowbase-pause` 影响。

### 5.6 每周期成本

一次 ≤8KB 文件读 + 每 target 一次字符串比较。可忽略。

## 6. 改动清单

| 文件 | 改动 |
|---|---|
| `src/agent-config.ts` | 新增 `findIndexFile()`（大小写不敏感定位）与 `readIndex()`（读取 + 标记中和 + 截断）；`buildBlock(dir, index)`；`installAgentConfig` → `syncAgentConfig`；写入改原子 |
| `src/config.ts` | `Config.agentConfig?: boolean`，`loadConfig` 默认 `true` |
| `src/commands/init.ts` | 持久化 `agentConfig` 字段；调用改名后的函数 |
| `src/sync-engine.ts` | `runCycle` 末尾按开关调 `syncAgentConfig`，try/catch，变更时记日志 |
| `src/commands/status.ts` | 新增一行可观测性：`agent 提示词：已同步（索引 1.2KB）` / `已关闭` / `索引缺失` |
| `src/commands/uninstall.ts` | 无需改动（`stripBlock` 已能精确移除） |
| `README.md` / `package.json` | 更新「与 AI agent 集成」章节；版本 0.3.0 |

## 7. 测试计划

`test/agent-config.test.ts`：

1. 索引存在 → 区块含全文与 `###` 索引标题
2. 索引缺失 → 区块含回退文案、无索引标题、不抛错
3. 文件名为 `Index.md` / `INDEX.md` 时同样被识别
4. `index.md` 与 `Index.md` 并存时取 `index.md`。并存状态在大小写不敏感的文件系统上无法构造，因此 `findIndexFile` 的选取逻辑要写成接受「条目名数组」的纯函数，本用例直接测该纯函数，不落盘
5. 索引超 8KB → 被截断、含截断提示、截断点落在行边界
6. 索引正文含 `KNOWBASE:END` → 被中和；`install → strip` 往返后用户原有内容完整保留
7. 内容未变 → `action === "unchanged"` 且文件 mtime 不变（未落盘）
8. `install → 改索引 → sync → uninstall` 往返，用户在同一文件中的其他内容原样保留

`test/sync-engine.test.ts`：

9. `agentConfig: false` → 一个周期后提示词文件未被写入
10. `syncAgentConfig` 抛错 → `syncOnce` 结果与 `DaemonState` 不受影响，daemon 继续运行

## 8. 可观测性

这个机制默认静默运行，用户无从感知是否生效。`knowbase status` 增加一行，报告：开关状态、索引是否存在、注入的索引字节数、是否被截断。
