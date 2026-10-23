# knowbase

> 以飞书知识库为唯一真相源的团队知识镜像。**安装即忘**：一条命令接入，开机自启，后台自动把飞书内容同步成本地只读 Markdown，人和 AI 都能直接 grep。

面向重度使用 Claude Code / Codex / Cursor / Hermes 等 agent 的团队：组织的业务背景、历史决策、环境配置等**隐性知识**写在飞书知识库里（人的习惯不用改），knowbase 在每个成员本机维护一份只读镜像，让 agent 能零延迟、无外网依赖地 grep 到这些知识。

**读走本地，写走飞书。** 本地目录是镜像，不是副本——所有 `.md` 设为只读，任何本地改动都会在下个同步周期被丢弃。要改知识，用文件头 frontmatter 里的 `feishu_url` 去飞书编辑，几分钟内自动回流到所有人本机。

> **1.0.0 起只支持飞书镜像模式。** 此前的「经典模式」（本地可写、与 Git 远端双向同步、union 合并 + 冲突副本）已废弃：`pause` / `resume` 命令、push 权限熔断、冲突副本机制一并移除。仍需要双向同步的请留在 0.9.x —— 1.0.0 对非镜像仓库会拒绝接入、也拒绝同步（绝不会把它当镜像 reset 掉）。

## 安装

```bash
npm i -g knowbase
```

依赖系统已安装 `git`（建议 ≥ 2.30）；Node ≥ 18。

## 快速开始

先有一个镜像仓库（由 `knowbase exporter` 从飞书导出，见下文），然后每个成员：

```bash
# 一次性接入：环境检查 → clone → 上只读锁 → 注册开机自启 → 配置 agent 提示词
knowbase init git@github.com:your-org/knowledge-mirror.git

# 之后什么都不用做。想看状态：
knowbase status
```

接入后，知识库就是一个普通的只读文件夹（默认 `~/org-kb`）。你和 agent 直接 grep / 读里面的 Markdown，后台守护进程负责把飞书的更新拉下来。

## 命令

| 命令 | 作用 |
|---|---|
| `knowbase init <git-url> [--dir <path>] [--branch <b>] [--interval <秒>] [--no-agent-config] [--no-skills]` | 一次性接入，注册开机自启，并配置 Claude Code / Codex / Cursor / Hermes 知识库上下文 |
| `knowbase status` | 一屏健康度：守护进程 / 上次同步 / 本地改动丢弃记录 / 远端连通性 |
| `knowbase sync` | 立即从镜像拉取一次（前台输出，不必等轮询；也用于排查） |
| `knowbase exporter` | 飞书 → 仓库的导出守护进程（部署在服务器侧，见下文） |
| `knowbase uninstall` | 干净移除：注销自启、停止守护进程、删除配置与 agent 提示词区块，**保留本地文件夹**（及日志备查） |

## 同步策略：严格单向下行

每个同步周期只做三件事：本地有改动就丢弃 → `fetch` → 落后或分叉就 `reset --hard` 到远端。**永不 commit、永不 push。**

- **下行轮询**：默认每 60 秒 `fetch` 一次（Git 无推送通知，轮询不可省）。
- **文件监听 + 防抖**：镜像目录是只读的，监听的意义不是加速上行，而是本地一旦被改（绕过只读位、或某个工具写入）几秒内就触发一轮丢弃，把偏离窗口压到最小。

任一步网络失败只记日志、下周期重试，进程永不崩溃退出。

因为不存在本地写入，**也就不存在冲突**——union 合并、冲突副本、push 权限熔断这些经典模式的机制在 1.0.0 中已全部移除。

> 文件监听在 macOS / Windows 原生可用；Linux 需 Node ≥ 20，否则自动退化为纯轮询。如需关闭监听，在 `config.json` 中加 `"watch": false`。

### 只读是怎么实现的

知识库内所有 `.md` 被设为 `0o444`。这是一道**提示性**防线，不是安全边界：它挡住的是 agent 和编辑器的意外写入，不是刻意绕过。绕过只读位写进去的内容同样会在下个周期被丢弃，`knowbase status` 会列出被丢弃的文件。

`init` 和守护进程只对镜像仓库（仓库根存在 `.knowbase-mirror.json`）工作。**非镜像仓库一律原地不动**：`init` 直接拒绝接入，`syncOnce` 每轮返回明确错误且不碰 git。这是有意为之——同步手段是 `reset --hard`，把一个可写仓库误当镜像处理等于抹掉成员未推送的全部内容，宁可什么都不做。

## 与 AI agent 集成（自动）

`init` 会**自动**把一段知识库使用说明写入你本机各 AI agent 的**全局提示词**文件，让 agent 天然知道「组织知识库在哪、怎么读写」，无需你手动粘贴：

| Agent | 全局提示词文件 |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| Cursor 桌面版 / CLI | 全局 `~/.cursor/hooks.json` 的 `workspaceOpen` hook 加载 `~/.cursor/knowbase/plugin/` 中的知识库规则 |
| Hermes | `~/.hermes/plugins/knowbase-context/` 注入系统提示词；支持自定义 `HERMES_HOME` |

Claude Code / Codex 使用全局 Markdown 文件；Cursor 和 Hermes 仅在检测到已安装客户端时配置官方 hook / 插件入口，不会在未安装的机器上创建其配置目录。已有用户升级后，重新执行原来的 `knowbase init <git-url>` 完成新客户端接入；后台只刷新既有上下文。Cursor 重新打开工作区后加载规则，Hermes 启动新会话（使用常驻 gateway 时重启 gateway）后生效。

Cursor 需要支持 `workspaceOpen` / `pluginPaths` 的版本（沙盒验证使用 CLI `2026.10.16-e3cb207`）；Hermes 需要支持 `register_system_prompt_section` 的插件 API。Hermes 的 `plugins.disabled` 显式禁用会保留，个人 `SOUL.md` 不修改。Hermes 插件上下文最多 4,000 字符，目录树超长时附 grep 提示。已有 JSON / YAML 无效或同名目录非托管时会提示并跳过，不覆盖原配置。

使用自定义 Hermes 实例时，在 `init` 前设置 `HERMES_HOME`。所选绝对路径会保存到 knowbase 配置的 `hermesHome`，守护进程、status 和 uninstall 不依赖原来交互终端的环境变量。一次接入维护一个 Hermes 实例；切换实例需重新 init。

写入的内容是一个带标记的**托管区块**：

```markdown
<!-- KNOWBASE:START （由 knowbase 自动管理，勿手动编辑本区块） -->
## 组织知识库（knowbase · 飞书镜像）
`~/org-kb` —— 飞书知识库的只读本地镜像
...（读走本地 grep / 写走 feishu_url + lark-doc / 导航约定）...

### 知识库目录树（由 knowbase 自动生成）

项目/
  hicreator-contract 合同中台.md
  …另有 189 篇未列出（本目录共 199 篇），grep 本目录定位
  lessie-email 多服务商邮件后端.md
踩坑记录.md
<!-- KNOWBASE:END -->
```

区块中的写入准则划分了**组织知识 vs 个人内容**的边界：只沉淀对团队其他成员有复用价值的组织级知识（业务规则、技术决策、公共配置、通用踩坑）；个人偏好、个人待办、个人私人信息不进共享知识库，拿不准时 agent 会先询问用户。准则刻意保持精简——它进入每次会话的上下文，每多一行都是持续成本。

> ⚠️ **准则不限制凭据写入，请自行评估。** 写进飞书的内容会被 exporter 导出成明文 Git 仓库，每个成员本地都持有全量 clone——凭据一旦入库即永久留在 Git 历史中，撤销飞书权限也收不回。需要收紧的话，改 [`src/agent-config.ts`](src/agent-config.ts) 中的准则文案（例如只记录凭据的位置与获取方式，值本身不落库）。

**自动目录树注入**：区块里内嵌知识库的目录树，agent 一开始就知道知识库里有什么、每个文件在哪个路径下，不必被提示才去 grep。

仓库根 `skills/` 及其全部子文件不会注入知识库目录树，也不计入目录树的文件数和上下文预算。团队 skills 仍按原机制独立分发，由各客户端按需发现和加载。

- **零维护、永不过期**：树由 knowbase 直接扫描文件系统生成，不依赖任何人工或 agent 维护的索引文件；文件名即飞书文档标题，本身就是天然的语义索引。
- **注入量与知识库规模无关**（0.9.0 起）：单个目录内文件超过 10 篇时只列**头尾各 5 篇**，中间折叠成一行「另有 N 篇未列出（本目录共 M 篇），grep 本目录定位」。注入行数的上界是「目录数 × 11」，跟文件总数无关——知识库涨到几千篇也撑不爆提示词预算。
  - 限宽而不限深，是因为知识库的增长发生在目录宽度上（同一主题下持续追加文档），深度由人在飞书里的节点层级决定、本身收敛。实测样本 12 篇里有 9 篇平铺在同一目录下，限深 3 层省 0 字节。
  - 留头也留尾（而不是只留前 10）：文件按名字排序，头尾两段合起来能露出这个目录的命名风格与取值范围，比同样字数的单侧前缀更能让 agent 判断「我要找的东西是否可能在这里」。
  - 隐藏数少于 3 篇时不折叠：折叠行本身约占 50 字节、一个中文文件名行约 45 字节，藏一两篇是净亏。
- **折叠处明确告知**：区块的导航段写明「树不是完整清单，树里找不到不等于库里没有」。否则 agent 会把列表当全集，找不到就下「知识库没有」的错误负结论——那比不注入更坏。
- **守护进程**每个同步周期自动刷新（前台 `knowbase sync` 不刷新）：文件增删后提示词区块随之更新，下次会话即生效。
- 守护进程只刷新**已存在**的区块，从不创建：区块只由 `init` 创建，手动删掉区块即等于关闭注入，后台不会写回。
- 兜底上限 32KB：目录数本身爆炸时（例如飞书里建了几百个节点）在行边界截断并提示 grep 全库。正常情况下有了宽度折叠根本撞不到。
- 知识库暂无文件时不报错，区块中改为提示 agent 直接 grep 全库。

- **幂等**：重复 `init` 只会原地更新该区块，不会重复堆叠。
- **不侵入**：只在文件末尾追加/更新自己的区块，你在同一文件里的其他内容原样保留。
- **可逆**：`knowbase uninstall` 会精确移除该区块，并保留你的其他内容。
- 不想自动写入：`init` 时加 `--no-agent-config`。

## 团队 skill 分发（自动）

知识库 `skills/<name>/SKILL.md`（需含 `name` / `description` YAML frontmatter）的团队 skill，会自动分发到以下目录，统一命名为 `org-<name>`。各端共用同一份标准格式和配套脚本，无需转换。

| Agent | 团队 skills 目录 | 分发条件 |
|---|---|---|
| Claude Code | `~/.claude/skills/` | 默认分发，兼容已有行为 |
| Codex | `~/.codex/skills/` | `.codex` 中有 `config.toml` / `auth.json` / `sessions` / `history.jsonl` / `logs` |
| Cursor 桌面版 / CLI | `~/.cursor/skills/` | `.cursor` 中有 `cli-config.json` / `ide_state.json` / `extensions` / `projects` |
| Hermes | `$HERMES_HOME/skills/`，默认 `~/.hermes/skills/` | 实例目录中有 `config.yaml` / `.env` / `sessions` / `state.db` |

每个同步周期重新检测安装状态；仅有 knowbase 创建的规则、hooks、plugins、skills 不算安装证据。首次由 knowbase 创建、且尚未被用户修改的 Hermes `config.yaml` 也不算独立安装证据，卸载时会清理。装上新客户端后 skills 下周期自动下发，上下文接入需重新执行 init。源变了就更新，删了就撤下，新增就装上；`status` 按客户端展示，`--no-skills` 对全部客户端生效。

```
知识库                              本机（每个成员）
skills/deploy/SKILL.md      ──►    ~/.claude/skills/org-deploy/SKILL.md   (name: org-deploy)
skills/deploy/SKILL.md      ──►    ~/.codex/skills/org-deploy/SKILL.md    (装了 Codex 时)
skills/deploy/SKILL.md      ──►    ~/.cursor/skills/org-deploy/SKILL.md   (装了 Cursor 时)
skills/deploy/SKILL.md      ──►    ~/.hermes/skills/org-deploy/SKILL.md   (装了 Hermes 时)
```

几条容易搞混的地方需要明确：

- **单向下发，托管副本是只读产物**：在 `~/.claude/skills/org-*/` 里手改**不会**回写知识库，下个同步周期会被静默覆盖（实现上是给每个副本单独算一份内容哈希，一旦跟落盘时的哈希对不上就判定「本机被动过」，触发重装）。想改一个团队 skill，去改知识库里的 `skills/` 目录，改动会通过正常的知识库同步扩散给所有人。
- **删掉 `~/.claude/skills/org-xxx/` 目录不是退订**：下个周期它会被原样重新分发——这与「删掉 agent 提示词里的托管区块就不再刷新」刻意不同，因为 skill 目录一删连托管标记都没了，没有地方记住「这个人拒绝过」。真要关闭，用 `knowbase init --no-skills` 接入，或在 `~/.config/knowbase/config.json` 里把 `"skills"` 设为 `false`。
- **同名保护**：如果你本机的 `~/.claude/skills/org-x` 不是 knowbase 建的（目录里没有 `.knowbase.json` 托管标记），一律不会被覆盖或删除。`knowbase status` 会把这种情况列成一条提示，并以非零退出码提醒你——通常改个名字，下一周期就能收到团队版。Codex / Cursor / Hermes 侧同理。
- **`name` 与 `description` 都是硬要求**：缺任一字段（或 `description` 为空）的 skill 会被跳过、不分发，`knowbase status` 里会列出原因。Claude Code 靠 `description` 判断何时触发一个 skill，缺了它等于分发一个装死的 skill，而团队会以为流程已经生效。
- `knowbase uninstall` 会清掉所有带托管标记的团队 skill 副本，你自己的 skill（无论是否叫 `org-*`）原样保留。

## 镜像模式的几个细节

- **自动识别，无需配置**：仓库根有 `.knowbase-mirror.json`（由 exporter 维护）即视为镜像仓库。成员不需要任何额外操作，团队也可以平滑切换仓库源头而不打断个人工作流。

- **agent 被引导成「读本地、写飞书」**：托管在 `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` 的区块明确写了——读知识走本地 grep（快、无外网依赖），改知识取文件头的 `feishu_url` 用 `lark-doc` 编辑，且编辑前先读飞书上的最新版（本地镜像可能落后几分钟）。新增文档用 `lark-wiki`，参照目录树自行判断挂在哪个节点下：**agent 的编辑与人类成员完全平权，没有专属 AI 的目录**。
  前置条件：成员机器需已配置 lark 工具链（`lark-doc` / `lark-wiki`）；未配置则 agent 只读，写入需人工在飞书完成。

- **`skills/` 不走飞书**：该目录不受镜像同步影响，通过仓库 PR 维护，照常自动分发到全团队。让可执行流程与知识库内容可以独立演进。

- **镜像新鲜度监控**：`knowbase status` 显示镜像的最后同步时间（`last_sync_at`）和全量对账时间（`last_full_check_at`）。超过 30 分钟未更新会警告 exporter 可能停摆，让团队及时发现导出流程的问题。

权限与可见性注意：飞书的细粒度可见性无法通过 git 导出带进镜像——镜像是纯文本，能 clone 仓库的所有人都能看到全部导出内容。
因此只应该镜像对整个团队都开放的 knowledge space（详见 docs/superpowers/specs/2026-09-02-lark-mirror-mode-design.md §10）。

## 部署 exporter（飞书 → 仓库）

建立镜像仓库的起点是将飞书知识库导出到 Git。`knowbase exporter` 部署为常驻守护进程，定时轮询飞书并推送更新到仓库；成员 `init` 时自动进入镜像模式，无需任何配置。

`deploy/exporter/` 包含：**Dockerfile**（Docker 部署）、**knowbase-exporter.service**（systemd 部署）、**README.md**（完整 7 步手册：应用创建 → 权限申请 → 加成员 → 冒烟验证 → 部署）。详见 [`deploy/exporter/README.md`](deploy/exporter/README.md)。

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
~/.claude/CLAUDE.md                   # init 写入 knowbase 托管区块（uninstall 移除）
~/.codex/AGENTS.md                    # 同上
~/.claude/skills/org-<name>/          # 知识库 skills/<name>/ 的托管副本（uninstall 移除）
~/.codex/skills/org-<name>/           # 同上，装了 Codex 时（uninstall 移除）
~/.cursor/knowbase/                  # Cursor 托管规则插件和 workspaceOpen 脚本
~/.cursor/hooks.json                 # 仅增删 knowbase 的 hook 注册项
~/.cursor/skills/org-<name>/          # Cursor 桌面版 / CLI 团队 skills
~/.hermes/plugins/knowbase-context/  # Hermes 托管上下文插件
~/.hermes/skills/org-<name>/          # Hermes 团队 skills（支持 HERMES_HOME）
```

## 升级

采用提示式升级（不做自动热更新）：有新版时命令会提示，手动执行 `npm i -g knowbase` 即可。

## npm 自动发布（维护者）

推送 `main` 会触发 [GitHub Actions](https://github.com/zhangze-github/knowbase/actions/workflows/publish.yml)：检查版本、运行测试、构建并检查打包内容，全部通过后发布 npm 上尚未存在的新版本。版本已发布时跳过发布；registry 查询失败、版本倒退或 lockfile 版本不一致时失败。

发布新版时，更新 CHANGELOG，执行 `npm version patch --no-git-tag-version`（也可用 `minor` / `major`），将 `package.json`、`package-lock.json` 和改动一起提交并推送到 `main`。无需另推版本标签，不会自动增加版本号；此流程仅发布稳定版本到 `latest`。

认证使用 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)，无需仓库 `NPM_TOKEN`。npm 包设置中授权 GitHub 用户 `zhangze-github`、仓库 `knowbase`、工作流文件 `publish.yml`，并允许直接 `npm publish`；不填写 Environment。授权变更可能需要包维护者完成一次 Passkey / 安全密钥验证。

## 环境变量

- `KNOWBASE_SKIP_AUTOSTART=1`：`init` 时跳过自启注册（用于 CI / 容器 / 手动托管守护进程的场景）。
- `KNOWBASE_QUIET_MS` / `KNOWBASE_MAXWAIT_MS`：调整文件监听防抖的静默期 / 最大等待（毫秒，默认 3000 / 30000）。

## Docker 沙盒测试

参见 [`test/sandbox/README.md`](test/sandbox/README.md)。测试使用独立容器 HOME，不挂载本机 agent 配置；完整回归以普通用户运行，避免 root 绕过只读权限导致假阳性。

Hermes 可用 OpenAI 兼容接口（如豆包）做真实模型验收。Cursor CLI 仍需 Cursor 服务的有效凭据，不能将普通 Chat Completions 地址直接替换为 Cursor 后端。

## License

MIT
