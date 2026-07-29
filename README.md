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
| `knowbase init <git-url> [--dir <path>] [--branch <b>] [--interval <秒>] [--write-claude-md]` | 一次性接入，注册开机自启并启动守护进程 |
| `knowbase status` | 一屏健康度：守护进程 / 上次同步 / 未推送改动 / 冲突副本 / 远端连通性 |
| `knowbase sync` | 立即触发一次同步周期（前台输出，用于排查和急用） |
| `knowbase pause` | 暂停自动同步（大范围改动期间用，避免半成品被提交） |
| `knowbase resume` | 恢复自动同步 |
| `knowbase uninstall` | 干净移除：注销自启、停止守护进程，**保留本地文件夹** |

## 同步与冲突策略

守护进程默认每 60 秒执行一次同步周期：本地有改动先提交，再 fetch，落后则合并，领先则推送。任一步网络失败只记日志、下周期重试，进程永不崩溃退出。

冲突处理的原则是**永不静默丢内容，永不阻塞等人**：

1. **union 合并**（覆盖约 95%）：仓库 `.gitattributes` 中 `*.md merge=union`，两端改同一区域时双方的行都保留。「乱但都在」优于「整齐但丢了」。
2. **冲突副本兜底**（union 覆盖不到的非 md 文件）：本地版本另存为 `原名.conflict-主机名-时间戳.扩展名`，原文件采用远端版本，两者一并提交推送，随同步扩散到所有设备，事后由人或 AI 合并。

## 与 AI agent 集成

`init` 会输出一段可粘贴到 `CLAUDE.md` / `AGENTS.md` 的集成片段（或用 `--write-claude-md` 直接写入知识库目录），告诉 agent 知识库位置与读写/暂停约定。

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
<知识库目录>/.knowbase-pause          # pause 的实现：存在即跳过同步周期
```

`.knowbase-pause` 已由 init 种入仓库 `.gitignore`，不参与同步。

## 升级

采用提示式升级（不做自动热更新）：有新版时命令会提示，手动执行 `npm i -g knowbase` 即可。

## 环境变量

- `KNOWBASE_SKIP_AUTOSTART=1`：`init` 时跳过自启注册（用于 CI / 容器 / 手动托管守护进程的场景）。

## License

MIT
