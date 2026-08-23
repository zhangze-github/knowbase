# 团队 skills 分发新增 Codex 目标（v0.7.0）

> 前置：[团队 skills 分发](2026-08-05-skills-sync-design.md)。本文档描述把知识库 `skills/` 的分发目标从仅 Claude Code 扩展为 Claude Code + Codex 的设计。

## 1. 问题

skills 分发设计（2026-08-05）的非目标里写着「不对接 Codex。Codex 没有 skills 目录机制」。这个判断已经过时：Codex 现已原生支持 agent skills——`~/.codex/skills/` 树下任意含 `SKILL.md` 的目录都会被发现，frontmatter 格式（`name:` + `description:`）与 Claude Code 完全同构，同一份文件两边通用，无需任何转换。

knowbase 的 agent 集成一直是双目标的（`agent-config.ts` 同时写 `~/.claude/CLAUDE.md` 与 `~/.codex/AGENTS.md`），skills 分发只覆盖 Claude Code 是能力缺口：团队里用 Codex 的成员拿得到知识库上下文，却拿不到团队 skills。

## 2. 目标与非目标

**目标**：知识库 `skills/` 下的 skill 同时分发到 `~/.claude/skills/` 与 `~/.codex/skills/`，语义与现有机制完全一致（单向、org- 前缀、托管标记、静默覆盖、删除传播）。

**非目标**：

- **不做格式转换**。两端 SKILL.md 同构，副本内容逐字节相同（含 `name:` 改写）。若未来某端格式分叉，届时再引入转换层。
- **不做 per-target 开关**。opt-out 仍只有配置层的 `skills: false` 一个总开关，没有「只分发给 Claude 不给 Codex」的机制。Codex 侧的"开关"是安装状态本身（见 §3）。
- **不新增其他工具**（Cursor 等）。本次只加 Codex；目标数组的结构让未来新增是加一行的事，但那是另一次决策。

## 3. 门控：真实装了 Codex 才分发

Codex 目标仅当 **`~/.codex` 是目录，且目录里存在至少一个已知的 Codex 自产条目**时生效；`~/.claude/skills` 维持现状无条件分发。已知条目取一个固定的正向标记列表：`config.toml` / `auth.json` / `sessions` / `history.jsonl` / `logs`（文件或目录皆可，命中任意一个即判定已安装）。

> 修订记录：本节最初版本用的是反向排除——只把 `~/.codex/AGENTS.md`（knowbase 自己写的全局提示词）排除在外，「目录里有 AGENTS.md 以外的东西」即判定已安装。这个方案在最终评审中被推翻，理由见下。

- **不能只判断「`~/.codex` 存在」**：knowbase 自己的 `syncAgentConfig` 会给每个用户写 `~/.codex/AGENTS.md`，而 `writeFileAtomic` 内部无条件 `mkdirSync(dirname, {recursive:true})`——任何跑过一次 `knowbase init` 的机器，不管装没装 Codex，`~/.codex` 目录都会被 knowbase 自己造出来。「目录存在」这个信号因此失效。
- **反向排除为什么被放弃**：knowbase 在 `~/.codex` 下会留下的自产条目集合是开放的，黑名单排不完——
  - `writeFileAtomic` 失败或进程被 `SIGKILL` 杀在 `rename` 之前，会在 `~/.codex` 下留一个 `AGENTS.md.knowbase-tmp-<pid>` 临时文件，`cleanTmpDirs` 只扫各 skills 目标目录、不扫 `~/.codex` 本身，这个文件永久不会被清理。只排除 `AGENTS.md` 挡不住它，一次崩溃就能把一台从未装过 Codex 的机器永久误判为「装了」。
  - 本功能自己会在判定为「已安装」后于 `~/.codex` 下建出 `skills/` 子目录（`syncSkillsToTarget` 的 `mkdirSync`）。反向排除下这个目录本身就会让下一周期继续判定为「已安装」——即使真实的 Codex 从未存在或已被卸载，也无法退回未安装状态，形成单向锁存（latch），直接违反本节「门控每周期动态求值」与 CHANGELOG「卸掉 Codex 后下个周期自动停止」的承诺。
  - 用户在 Finder 里打开一次 `~/.codex` 就会落下 `.DS_Store`，同样会被误判。
  - 最初版本「不挑具体文件名，因为全新安装可能还没生成它」这个顾虑不成立：Codex 从未运行过时 `~/.codex` 根本不存在（读取失败分支已经短路成未安装）；目录存在就意味着 Codex 至少运行过一次，运行过一次就会落下标记列表里的至少一项。
- 判断 `~/.codex` 而非 `~/.codex/skills`：装了 Codex 但从未建过 skills 目录的机器也该收到分发，`~/.codex/skills` 由安装分支现有的 `mkdirSync` 创建。
- 读取失败（不存在、`EACCES`、`~/.codex` 是普通文件等）一律视为未安装、跳过分发，不报错——判断不出真实安装状态时，保守地不分发比抛异常中断整个同步更安全。
- 门控每周期动态求值：装 Codex 后下个同步周期自动开始分发，`~/.codex` 消失（或退化成不再含任何标记条目）后自动停止并且**不删已分发的副本**（目录都没了副本自然也没了；若只删 skills 子目录，下周期门控失败不再管它——不为病态状态设计清理路径）。正向标记天然不含 knowbase 自己会产出的任何名字，因此不会重新锁存。

选「真实装了才分发」而非「无条件分发」（与 agent-config 的无条件写入不同）的理由：agent-config 只在 init 跑一次，不写就永远没机会；skills 分发每周期都跑，门控可以自愈，而无条件分发会在没装 Codex 的机器上留一棵永远无人消费的目录树，uninstall 也要多清理一处。

## 4. 结构：目标列表参数化

```ts
export interface SkillTarget {
  /** 展示名，用于日志、status、uninstall 输出。 */
  name: string;
  /** skills 落地目录绝对路径。 */
  dir: string;
}

/** 返回当前生效的分发目标。Codex 仅在真实装了 Codex（见 §3）时出现。 */
export function skillTargets(home: string = os.homedir()): SkillTarget[]
```

- `skillTargets` 取代 `skillsHomeDir` 成为唯一的目标来源；`skillsHomeDir` 删除，现有消费方（status.ts 用它 + `readExistingTargets` 读现状）改为遍历 `skillTargets`。
- 门控知识（「Codex 装了没」）只存在于 `skillTargets` 一处，四个消费方（sync-engine、init、status、uninstall）都通过它取目标，与 `agent-config.ts` 的 `agentTargets()` 模式对称。

**否决的替代结构**：

| 方案 | 结论 |
|---|---|
| 调用方循环（`syncSkills(kbDir, targetDir)`，各调用点自己遍历） | 否决。门控判断要在四个调用点重复，知识分散 |
| teamai 式 ResourceHandler 多目标抽象层 | 否决。两个同构目标不需要抽象层，过度设计 |

## 5. 同步流程

`syncSkills(kbDir, home)` 签名不变，内部改为：

1. `readSkillSources(kbDir)` **只读一次**——源侧扫描、校验、大小写去重与目标无关，双目标共享同一份源列表与 `protectedTargets`。
2. 对 `skillTargets(home)` 的每个目标独立执行现有全流程：`cleanTmpDirs` → `readExistingTargets` → `planSkills` → 按 removed-先行序执行安装/删除。
3. `planSkills` 等纯决策层**一行不动**；marker、`org-` 前缀、`rewriteSkillName`、临时目录 + rename、pid 机制全部原样复用。各目标的临时目录在各自 skillsHome 下，天然互不干扰。

## 6. 结果类型与输出归属

`SkillChange` 与 `SkillRemoval` 增加 `tool: string` 字段（目标展示名）。双目标下 `org-foo(created)` 会出现两次，无归属则日志与 status 无法解读。

- `readSkillSources` 产出的 invalid 条目与目标无关，`tool` 置空串，打印时不带归属前缀（源侧问题本来就不属于任何目标）。
- sync-engine 的变更通知合并为一条，按工具分组，如：`团队 skills 已更新：Claude Code org-foo(created)、org-bar(updated)；Codex org-foo(created)`。
- 只有一个目标生效时（未装 Codex），输出格式与现状保持一致的信息量即可，不强求逐字节兼容。

## 7. status 与 uninstall

- **status**：按目标分别展示分发状态。未检测到真实 Codex 安装时**不显示 Codex 行**——status 的原则是一屏健康度，没装的工具不是健康问题，不制造噪音。
- **uninstall**：遍历 `skillTargets()` 返回的每个目标执行现有「只删带标记副本」逻辑，输出带工具名。未检测到真实 Codex 安装时天然跳过（门控已滤掉）。

## 8. 错误处理

现有不变式全部保留：无标记不碰、单 skill 失败记 failed 继续、removed 先于 created、空 target 拒绝删除。

新增一层隔离要求：**单个目标整体不可用**（如 `~/.codex/skills` 权限异常）**不影响另一目标**。现有机制天然满足——`readExistingTargets` 吞读取错误、安装失败落 failed 条目——本次以测试固化该行为，不新增代码路径。

## 9. 注释与文档修正

- 删除/改写三处过时表述：`skills-sync.ts` 头注释「只对 Claude Code 生效：Codex 没有 skills 目录机制」、`skillsHomeDir` 的「只有 Claude Code 有这个机制」、`sync-engine.ts` 分发段的单目标表述。
- 2026-08-05 spec 的非目标条目不改（历史文档记录当时的判断），本文档即其修订。
- README 更新 skills 分发相关表述；CHANGELOG 走 0.7.0（新能力，minor）。

## 10. 测试

- `skillTargets` 门控：`~/.codex` 不存在 / 是普通文件 / 是空目录 / 只有 `AGENTS.md` / 只有 `AGENTS.md` 的原子写临时文件残留 / 只有本功能自建的 `skills/` 目录（锁存回归）/ 有真实 Codex 标记文件（含与 `AGENTS.md` 并存），共七种情况（注入临时 home）。
- 双目标分发：同一源在两个 skillsHome 各得一份带独立 marker 的副本，`SKILL.md` 的 `name:` 均被改写。
- 目标隔离：一个目标安装失败（构造只读 skillsHome），另一目标正常完成且结果条目归属正确。
- 删除传播：源删除后两个目标的托管副本都被清理。
- uninstall：双目标清理、`tool` 字段透传到输出、未装 Codex 时只清 Claude 侧。
- 现有单目标测试改造为对 Claude 目标的断言，行为不回归。
