# knowbase

> AI 时代的团队知识库同步工具。**安装即忘**：一条命令接入，开机自启，后台自动双向同步，冲突全自动处理，永不需要人介入。

面向重度使用 Claude Code / Codex 等 coding agent 的团队：把组织的业务背景、历史决策、环境配置等**隐性知识**变成一个普通的本地 Markdown 文件夹，人和 AI 都能直接 grep、直接读写。knowbase 负责让这个文件夹与 Git 远端（GitHub / GitLab 私有仓库）在后台无人值守地保持同步——用户永远不需要接触 pull / push / commit / 冲突这些概念。

## 安装

```bash
npm i -g knowbase
```

依赖系统已安装 `git`（建议 ≥ 2.30）；Node ≥ 18。

## 快速开始

```bash
# 一次性接入：环境检查 → clone → 种入规则 → 注册开机自启 → 输出集成片段
knowbase init git@github.com:your-org/knowledge-base.git

# 之后什么都不用做。想看状态：
knowbase status
```

接入后，知识库就是一个普通文件夹（默认 `~/org-kb`）。你和 agent 直接在里面读写 Markdown，**保存即是全部动作**——后台守护进程会自动提交、拉取、合并、推送。

## 命令

| 命令 | 作用 |
|---|---|
| `knowbase init <git-url> [--dir <path>] [--branch <b>] [--interval <秒>] [--no-agent-config]` | 一次性接入，注册开机自启，并自动配置 Claude Code / Codex 全局提示词 |
| `knowbase status` | 一屏健康度：守护进程 / 上次同步 / 未推送改动 / 冲突副本 / 远端连通性 |
| `knowbase sync` | 立即触发一次同步周期（前台输出，用于排查和急用） |
| `knowbase pause` | 暂停自动同步（大范围改动期间用，避免半成品被提交） |
| `knowbase resume` | 恢复自动同步 |
| `knowbase uninstall` | 干净移除：注销自启、停止守护进程、删除配置与 agent 提示词区块，**保留本地文件夹**（及日志备查） |

## 同步与冲突策略

同步是**混合调度**的：

- **上行（本地 → 远端）**：文件监听 + 防抖。保存后静默 3 秒即自动同步（连续编辑最迟 30 秒必同步一次），改动几秒内就推到远端——推得快也让多设备并发编辑的冲突窗口更小。
- **下行（远端 → 本地）**：默认每 60 秒轮询 fetch 一次（Git 无推送通知，轮询不可省），同时兜底监听失效的情况——最坏退化为纯轮询。

每个同步周期：本地有改动先提交，再 fetch，落后则合并，领先则推送。任一步网络失败只记日志、下周期重试，进程永不崩溃退出。

> 文件监听在 macOS / Windows 原生可用；Linux 需 Node ≥ 20，否则自动退化为纯轮询。如需关闭监听，在 `config.json` 中加 `"watch": false`。

冲突处理的原则是**永不静默丢内容，永不阻塞等人**：

1. **union 合并**（覆盖约 95%）：仓库 `.gitattributes` 中 `*.md merge=union`，两端改同一区域时双方的行都保留。「乱但都在」优于「整齐但丢了」。
2. **冲突副本兜底**（union 覆盖不到的非 md 文件）：本地版本另存为 `原名.conflict-主机名-时间戳.扩展名`，原文件采用远端版本，两者一并提交推送，随同步扩散到所有设备，事后由人或 AI 合并。

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

## 与 AI agent 集成（自动）

`init` 会**自动**把一段知识库使用说明写入你本机各 AI agent 的**全局提示词**文件，让 agent 天然知道「组织知识库在哪、怎么读写」，无需你手动粘贴：

| Agent | 全局提示词文件 |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |

写入的内容是一个带标记的**托管区块**：

```markdown
<!-- KNOWBASE:START （由 knowbase 自动管理，勿手动编辑本区块） -->
## 组织知识库（knowbase）
本机知识库位于：`~/org-kb`
...（读写准则 / 暂停约定 / 导航约定）...

### 知识库索引（根 index.md 快照，由 knowbase 自动同步）
...（知识库根 index.md 全文）...
<!-- KNOWBASE:END -->
```

区块中的写入准则划分了**组织知识 vs 个人内容**的边界：只沉淀对团队其他成员有复用价值的组织级知识（业务规则、技术决策、公共配置、通用踩坑）；个人偏好、个人待办、个人私人信息不进共享知识库，拿不准时 agent 会先询问用户。准则刻意保持精简——它进入每次会话的上下文，每多一行都是持续成本。

> ⚠️ **准则不限制凭据写入，请自行评估。** 知识库是明文 Git 仓库，同步为 `git add -A` + 自动提交推送，无人工复核。凭据一旦入库即永久留在 Git 历史中，且每个成员本地都持有全量 clone——撤销远端权限也收不回。需要收紧的话，改 [`src/agent-config.ts`](src/agent-config.ts) 中的准则文案（例如只记录凭据的位置与获取方式，值本身不落库），或用 SOPS / git-crypt 加密特定目录。

**自动索引注入**：区块里内嵌知识库根目录 `index.md` 的全文快照，agent 一开始就知道知识库里有什么，不必被提示才去 grep。

- **守护进程**每个同步周期自动刷新（前台 `knowbase sync` 不刷新）：索引变了（本地改的或从远端拉来的），提示词区块随之更新，下次会话即生效。
- 守护进程只刷新**已存在**的区块，从不创建：区块只由 `init` 创建，手动删掉区块即等于关闭注入，后台不会写回。
- 文件名大小写不敏感：`index.md` / `Index.md` / `INDEX.md` 都认（避免 macOS 能读、Linux 读不到的跨平台不一致）。
- 上限 8KB：超出部分在行边界截断并附上完整文件路径，防止索引长起来静默吃掉每次会话的上下文预算。
- 根目录还没有 `index.md` 时不报错，区块中改为提示 agent 直接 grep 全库。
- 索引内容本身由你自己维护（人工或专门的索引维护 agent）——knowbase 只负责注入，不生成、不覆盖。
- 子目录索引不注入：区块里的导航约定会让 agent 进入子目录前先读该目录的 `index.md`。

- **幂等**：重复 `init` 只会原地更新该区块，不会重复堆叠。
- **不侵入**：只在文件末尾追加/更新自己的区块，你在同一文件里的其他内容原样保留。
- **可逆**：`knowbase uninstall` 会精确移除该区块，并保留你的其他内容。
- 不想自动写入：`init` 时加 `--no-agent-config`。

## 团队 skill 分发（自动）

知识库不只沉淀散文——写在 `<知识库目录>/skills/<name>/SKILL.md`（需含 `name` / `description` 的 YAML frontmatter）的 Claude Code skill，会被自动分发到团队每个成员本机的 `~/.claude/skills/org-<name>/`。守护进程每个同步周期检测一次：源变了就更新，删了就撤下，新增就装上。写入区块的准则里也会提示 agent 把「怎么做某件事」的可执行流程沉淀到这里，而不是只写散文（见上一节的托管区块文案）。

```
知识库                              本机（每个成员）
skills/deploy/SKILL.md      ──►    ~/.claude/skills/org-deploy/SKILL.md   (name: org-deploy)
```

几条容易搞混的地方需要明确：

- **单向下发，托管副本是只读产物**：在 `~/.claude/skills/org-*/` 里手改**不会**回写知识库，下个同步周期会被静默覆盖（实现上是给每个副本单独算一份内容哈希，一旦跟落盘时的哈希对不上就判定「本机被动过」，触发重装）。想改一个团队 skill，去改知识库里的 `skills/` 目录，改动会通过正常的知识库同步扩散给所有人。
- **删掉 `~/.claude/skills/org-xxx/` 目录不是退订**：下个周期它会被原样重新分发——这与「删掉 agent 提示词里的托管区块就不再刷新」刻意不同，因为 skill 目录一删连托管标记都没了，没有地方记住「这个人拒绝过」。真要关闭，用 `knowbase init --no-skills` 接入，或在 `~/.config/knowbase/config.json` 里把 `"skills"` 设为 `false`。
- **同名保护**：如果你本机的 `~/.claude/skills/org-x` 不是 knowbase 建的（目录里没有 `.knowbase.json` 托管标记），一律不会被覆盖或删除。`knowbase status` 会把这种情况列成一条提示，并以非零退出码提醒你——通常改个名字，下一周期就能收到团队版。
- **只对 Claude Code 生效**：Codex 没有 skills 目录机制，这条分发链路不涉及 `~/.codex/`。
- `knowbase uninstall` 会清掉所有带托管标记的团队 skill 副本，你自己的 skill（无论是否叫 `org-*`）原样保留。

## 开机自启机制

| 平台 | 机制 |
|---|---|
| macOS | launchd LaunchAgent（RunAtLoad + KeepAlive） |
| Linux | systemd user service（自动 `loginctl enable-linger`） |
| Windows | 计划任务（登录触发，VBS 隐藏窗口启动） |

守护进程崩溃由服务管理器自动重启。

## 文件与配置

```
~/.config/knowbase/config.json        # 仓库地址、本地目录、同步间隔、分支
~/.config/knowbase/knowbase.log       # 滚动日志（status 报错时引导看这里）
~/.config/knowbase/daemon.state.json  # 守护进程心跳（供 status 判断存活）
~/.config/knowbase/daemon.stdout.log  # 服务管理器重定向的守护进程 stdout/stderr
<知识库目录>/.knowbase-pause          # pause 的实现：存在即跳过同步周期
~/.claude/CLAUDE.md                   # init 写入 knowbase 托管区块（uninstall 移除）
~/.codex/AGENTS.md                    # 同上
~/.claude/skills/org-<name>/          # 知识库 skills/<name>/ 的托管副本（uninstall 移除）
```

`.knowbase-pause` 已由 init 种入仓库 `.gitignore`，不参与同步。

## 升级

采用提示式升级（不做自动热更新）：有新版时命令会提示，手动执行 `npm i -g knowbase` 即可。

## 环境变量

- `KNOWBASE_SKIP_AUTOSTART=1`：`init` 时跳过自启注册（用于 CI / 容器 / 手动托管守护进程的场景）。
- `KNOWBASE_QUIET_MS` / `KNOWBASE_MAXWAIT_MS`：调整上行防抖的静默期 / 最大等待（毫秒，默认 3000 / 30000）。

## License

MIT
