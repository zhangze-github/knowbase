# 团队 skills 分发（v0.6.0）

> 前置：[knowbase 实现设计](2026-07-29-knowbase-design.md)、[知识库索引自动注入](2026-08-04-kb-index-injection-design.md)。本文档描述把知识库 `skills/` 目录下的 Claude Code skill 单向分发到本机 `~/.claude/skills/` 的设计。

## 1. 问题

知识库现在只能沉淀**散文**——业务背景、技术决策、踩坑记录。但团队最值钱的沉淀不是「事实」，而是「怎么做这件事的可执行流程」：某个成员把一套 review / 发布 / 排查流程调顺了，这份能力目前无法分发给其他人的 agent，只能靠口头转述或复制粘贴。

Claude Code 原生支持 `~/.claude/skills/<name>/SKILL.md` 形态的个人 skill。知识库既然已经是一个后台自动同步的本地目录，把 skill 目录纳入同步就能让 org-kb 从「只读上下文」变成**团队能力分发通道**：一个人调好，全团队的 agent 下一个周期就有了。

## 2. 目标与非目标

**目标**：知识库 `skills/` 下的 skill 自动出现在每个成员的 Claude Code 中，随知识库变化自动更新，用户零操作。

**非目标**：

- **不做双向**。托管副本是只读分发产物；在 `~/.claude/skills/` 里手改不会回写知识库，下个周期被静默覆盖。贡献路径只有一条：编辑知识库 `skills/` 目录。
- **不生成 skill 内容**。knowbase 只负责分发，不生成、不校验、不 lint。
- **不做 per-skill 开关**。opt-out 只在配置层（`--no-skills`），没有「只要这几个 skill」的机制。
- **不对接 Codex**。Codex 没有 skills 目录机制，本功能只对 Claude Code 生效。

## 3. 机制选型

| 方案 | 结论 |
|---|---|
| 每个 skill 一条 symlink 指向知识库 | 否决。零拷贝、编辑即生效，但语义是**双向**的：agent 在会话中改动 skill 等于直接改共享仓库并在数秒内推给全团队。用户明确选择单向下发。附带问题：Windows 建 symlink 需额外权限（需退化为 junction） |
| 整目录 symlink `~/.claude/skills` → `<kb>/skills` | 否决。Claude Code 的个人 skill 是**扁平**结构（`~/.claude/skills/<name>/SKILL.md`），整目录接管会顶掉用户自己的全部个人 skill |
| **逐个 skill 拷贝（选定）** | 单向、跨平台无差异、与「静默覆盖」语义一致。代价是内容有一个同步周期的过期窗口，且占双份磁盘（skill 体积极小，可忽略） |

## 4. 命名与前缀

托管副本一律落到 **`~/.claude/skills/org-<name>/`**。

前缀有两个作用：让 skill 列表里一眼看出哪些是团队的，以及从机制上消除与成员个人 skill 同名的可能——统一加前缀比「同名时跳过」更好，后者会让该成员静默拿不到团队版。

- 源名已以 `org-` 开头时不重复加前缀（`org-foo` → `org-foo`，不是 `org-org-foo`）。
- 拷贝后**改写副本** `SKILL.md` frontmatter 中的 `name:` 为 `org-<name>`，使目录名与字段永远一致。

改写 `name:` 是必须的：本机现有样本中目录名与 `name:` 字段全部一致，无法判定 Claude Code 按哪个识别 skill。既然是拷贝分发，改写副本可以彻底消掉这个不确定性——两种识别规则下都正确。

**已知代价**：若 skill 正文里用原名交叉引用另一个 skill（「调用 code-review skill」），改写后引用名与实际名不一致。不做递归改写：那需要理解正文语义，属于内容治理，不在本工具职责内。写入规范里提示用完整 `org-` 名引用即可。

## 5. 源侧识别

```
<kb>/skills/<name>/SKILL.md
```

- `<kb>/skills/` 不存在 → 整功能 no-op，不报错（与根 `index.md` 缺失同样处理）。
- 只扫**一级**子目录。不含 `SKILL.md` 的子目录忽略（可能是误放的素材目录）。
- `SKILL.md` 必须有 YAML frontmatter 且含 `name:` 字段，否则跳过并记日志——那不是一个合法 skill。
- 目录名必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`。不合规跳过并记日志。
- 一批源中出现仅大小写不同的名字（`Foo` 与 `foo`）时，取排序后第一个并记一次告警。理由与 [索引注入设计 §4.1](2026-08-04-kb-index-injection-design.md) 相同：macOS 大小写不敏感、Linux 敏感，不定死取值会产生「同一知识库在不同成员机器上行为不同」的极难排查问题。

  这段去重**必须抽成接受数组的纯函数** `dedupeByTargetCase(sources)`，与 `pickIndexName` 同一处理方式、同一理由：「仅大小写不同的两个目录并存」在大小写不敏感的文件系统上**无法落盘构造**——不敏感恰恰意味着 `Afoo` 与 `afoo` 就是同一个目录名，任何走文件系统的用例都测不到这条路径。

目录名校验是**安全要求**，不是洁癖：源目录名来自共享仓库（任何有写权限的成员都能改），且会直接拼进 `~/.claude/skills/` 的路径。不校验则 `../../` 这类名字能让写入落到 home 目录任意位置。

## 6. 托管标记 `.knowbase.json`

每个托管副本根下写一个：

```json
{
  "source": "code-review",
  "hash": "<源目录内容的 sha256>",
  "syncedAt": "2026-08-05T06:00:00.000Z"
}
```

一个文件干两件事：

1. **所有权证明**。`~/.claude/skills/` 下没有这个文件的目录一律不碰——包括用户自己恰好叫 `org-xxx` 的 skill。所有权信息放在目录内而非集中式 state 文件，是为了让孤儿识别自愈：state 文件丢失会让托管副本永久变成无人认领的垃圾，标记在目录内则永远认得出来。
2. **变更检测**。hash 相同即整目录跳过、零落盘。绝大多数周期都走这条。

`hash` 算的是**源**目录内容，算法：递归收集相对路径 → 按字典序排序 → 依次把 `相对路径 + \0 + 可执行位 + \0 + 文件字节` 喂进同一个 sha256。

- 含路径：否则源里增删文件（内容集合不变时）检测不到。
- 排序：否则结果依赖目录遍历顺序，跨平台不稳定。
- 含可执行位：skill 可能带脚本，`chmod +x` 而内容不变时也必须重新分发（见 §7.1）。
- 源侧若也存在 `.knowbase.json`（不该有，但成员可能误提交），它参与 hash 计算，但拷贝后会被目标标记覆盖。

## 7. 每周期决策

对每个合法源 skill，看目标 `~/.claude/skills/org-<name>/`：

| 目标状态 | 动作 | 说明 |
|---|---|---|
| 不存在 | `create` | 全新拷贝 |
| 存在，无 `.knowbase.json` | `foreign` | **跳过**，记日志，status 中列出 |
| 存在，有标记，hash 相同 | `unchanged` | 不落盘 |
| 存在，有标记，hash 不同 | `update` | 整体重建 |

再反向扫一遍：`~/.claude/skills/` 下所有含 `.knowbase.json` 的目录，其 `source` 不在当前源列表中 → `orphan`，删除。覆盖「知识库里删了 skill」与「重命名了 skill」两种情况。

同时清理上次崩溃残留的 `*.knowbase-tmp-*` 目录。

### 7.1 写入方式：临时目录 + rename

`create` / `update` 均为整体替换，不做原地增量：

```
拷贝源树 → org-<name>.knowbase-tmp-<pid>/   （同级临时目录）
改写其中 SKILL.md 的 name: 字段
写入 .knowbase.json
删除旧目标（若存在）
rename 临时目录 → org-<name>/
```

- **不增量**：源里删了文件，增量拷贝检测不到，副本里会残留幽灵文件。整体替换最简单可靠。
- **临时目录 + rename**：避免「删了旧的、拷贝中途崩溃」留下半个 skill 被 Claude Code 加载。rename 始终同目录、同文件系统。
- **临时名带 pid**：与 [`agent-config.ts` 的 `writeFileAtomic`](../../../src/agent-config.ts) 同一理由——守护进程的周期刷新与用户手跑的 `init` 会同时写同一目标，共用固定临时名会让两个进程交错写入同一临时目录。

拷贝规则：

- **跳过 `.git`**（防御性：正常的 org-kb 里 skill 目录下不会有嵌套仓库）。
- **保留可执行位**。skill 可以带脚本；丢了 `+x` 脚本就跑不起来，而这种失败在 agent 侧极难定位。其余权限位不保留，按默认 umask 落盘。
- **不跟随软链**：遇到软链跳过并记日志。git 会存软链，而一条指向作者机器路径的软链拷到别人机器上必然悬空——静默留一条坏链比缺一个文件更难查。

## 8. 集成点

| 文件 | 改动 |
|---|---|
| `src/skills-sync.ts` | **新增**。导出 `syncSkills(kbDir, home?)` / `uninstallSkills(home?)`，以及纯函数 `prefixedName` / `rewriteSkillName` / `hashSkillDir` / `planSkills` |
| `src/config.ts` | `Config.skills?: boolean`，`loadConfig` 中 `parsed.skills !== false` |
| `src/commands/init.ts` | `--no-skills` 选项与持久化；`syncAgentConfig(dir)` 旁调用 `syncSkills(dir)`，逐条打印结果 |
| `src/sync-engine.ts` | 新增 `refreshOrgSkills(cfg, logger, home?)`，与 `refreshAgentPrompts` 并列在 `runCycle` 末尾调用，整体 try/catch |
| `src/commands/uninstall.ts` | `uninstallAgentConfig()` 旁调用 `uninstallSkills()` |
| `src/commands/status.ts` | 新增一行：已分发数 / foreign 跳过名单 / `skills === false` 时的关闭提示 |
| `src/agent-config.ts` | 托管区块「写」那段增加一行写入规范：要沉淀可复用流程时写到 `<kb>/skills/<name>/SKILL.md` |
| `README.md` / `package.json` | 新增「团队 skills 分发」章节；版本 0.6.0 |

区块文案变更会使现有 `test/agent-config.test.ts` 中依赖区块全文的断言失败，需一并更新。

## 9. 两个刻意的不对称

这两条都与既有的 agent-config 行为相反，实现时必须写进注释，否则后来者会当成 bug「修掉」。

### 9.1 不用 `onlyExisting`：删掉托管目录会被重新分发

`refreshAgentPrompts` 传 `onlyExisting: true`，守护进程从不创建区块——因为区块在用户的个人提示词文件里，删掉它是用户表达「别往我提示词里塞东西」最自然的方式。

skills 这边相反：删掉 `~/.claude/skills/org-foo/`，下个周期会被重新分发。理由是删掉目录时标记文件也一起没了，「记住用户拒绝过这一个」需要引入新的持久化状态；而 opt-out 在配置层已经有了（`--no-skills`）。这是「单向下发 + 静默覆盖」的直接推论，但反直觉，README 必须明说。

### 9.2 前台 `knowbase sync` 不分发

只在 `init` 与守护进程周期跑，与既有「前台 `sync` 不刷新提示词」一致。`sync` 是排查 git 同步的命令，顺手改用户的 `~/.claude/` 是意外副作用；守护进程在一个周期内也会补上。

## 10. pause 与只读模式

- **不受 `.knowbase-pause` 影响**，与 `refreshAgentPrompts` 同理：纯本地读 + 写本机 `~/.claude/`，不碰 git，不存在「半成品被提交」的风险。pause 期间本机自己改的东西分发给本机自己，没有跨机风险。
- **只读模式无影响**：分发只依赖本地工作区内容，与 push 权限无关。

## 11. 错误处理

- 单个 skill 失败（读失败、拷贝失败、目标无写权限）→ 记日志、跳过、继续下一个。
- 整体包 try/catch：不影响 `SyncResult` / `DaemonState`，绝不让守护进程退出。
- `~/.claude/skills` 不存在 → `mkdirSync(recursive)` 创建。
- 返回 `SkillChange[]`（复刻 `AgentConfigChange[]` 的形状），由调用方决定打印还是记日志。

## 12. 测试计划

关键是把决策逻辑从 fs 副作用里剥出来独立测。

**纯函数（新 `test/skills-sync.test.ts`）**

1. `prefixedName()`：正常加前缀；已带 `org-` 前缀不重复加；非法目录名（含 `..`、`/`、前导 `.`、空串）返回 `null`
2. `rewriteSkillName()`：改写 frontmatter 中的 `name:`；只改 frontmatter 块内**第一个** `name:`（正文里出现的 `name:` 不动）；无 frontmatter 或无 `name:` 字段返回 `null`
3. `hashSkillDir()`：内容变则变；增删文件则变；文件重命名（内容集合不变）则变；`chmod +x` 而内容不变时也变；结果与遍历顺序无关
4. `planSkills(sources, existing)`：`create` / `update` / `unchanged` / `foreign` / `orphan` / `invalid` 六个分支全覆盖，不碰文件系统

**集成（tmpdir + 假 home，沿用 `test/helpers.ts` 的 `tmpDir` / `write`）**

5. 首次分发：目标目录存在、`SKILL.md` 的 `name:` 已改写为 `org-*`、`references/` 等子目录一并拷到、`.knowbase.json` 落盘
6. 二次调用无写入（比对目标文件 mtime）
7. 源内容改动 → 副本重建；**源里删掉一个文件 → 副本里也没了**（验证整体替换而非增量）
8. 源 skill 目录删除 → 托管副本被清理
9. 目标同名目录存在但无 `.knowbase.json` → 不碰其内容，动作为 `foreign`
10. 残留 `org-x.knowbase-tmp-123/` → 被清掉
11. `uninstallSkills()` → 托管副本全清；用户自己的 skill 与用户自建的 `org-*`（无标记）保留
12. 源 `SKILL.md` 缺 frontmatter / 缺 `name:` / 目录名非法 → 跳过，不影响其他 skill 的分发
13. 源里带可执行脚本 → 副本保留 `+x`
14. 源里有软链 → 跳过该条目，其余文件正常拷贝，副本中不出现坏链

**`test/sync-engine.test.ts`**

15. `skills: false` → 一个周期后 `~/.claude/skills/` 未被写入
16. `syncSkills` 抛错 → `syncOnce` 结果与 `DaemonState` 不受影响，守护进程继续运行

## 13. 可观测性

与索引注入同样的问题：默认静默运行，用户无从感知是否生效。`knowbase status` 增加一行，报告开关状态、已分发数量、被跳过的 foreign 名单：

```
• 团队 skills：已分发 4 个（org-*）
  ⚠ 跳过 org-deploy：同名目录不是 knowbase 托管的，未覆盖
```
