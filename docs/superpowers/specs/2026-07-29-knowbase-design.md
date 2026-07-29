# knowbase 实现设计

> 产品规格见 [product.md](../../../product.md)（已定稿）。本文档补充工程实现层面的决策，作为实现依据。
> 命名：npm 包名 & 命令均为 `knowbase`（源码仓库名保持 `lorebase`）。

## 1. 命名与约定（对 product.md 的具体化）

- npm 包名 / bin：`knowbase`
- 配置目录：`~/.config/knowbase/config.json`、`~/.config/knowbase/knowbase.log`
- 暂停标记文件：`<知识库目录>/.knowbase-pause`
- 自动提交信息前缀：`auto[<主机名>]: <文件名列表>`（超过 3 个文件计数）
- 冲突副本命名：`<原名>.conflict-<主机名>-<时间戳>.<扩展名>`
- 仓库种入 `.gitignore` 的条目：`.knowbase-pause`（其余日志/配置在 HOME，本就不在仓库内）

## 2. 技术栈

- **语言**：TypeScript，`tsc` 编译到 `dist/`（ESM，`type: module`，target Node18+），`bin` 指向带 shebang 的 `dist/cli.js`。
- **依赖最小化**：仅 `commander`（命令解析）+ `update-notifier`（升级提示，规格 2.2/3.1 要求）。
- **Git**：全部通过 `child_process` 调系统 git（规格 3.1：union merge driver、`git show :2:` 等需要完整 git 能力）。
- **测试**：`vitest`（devDependency），本地 bare 仓库模拟远端。

## 3. 模块划分（单一职责、可独立测试）

| 文件 | 职责 | 依赖 |
|---|---|---|
| `src/cli.ts` | 入口：参数解析、update-notifier、分发到命令；`daemon` 为隐藏命令 | commander, commands/* |
| `src/git.ts` | git 薄封装：`run/runOk`、`lsRemote`、`hasChanges`、`add`、`commit`、`fetch`、`behind/ahead`、`merge`、`push`、`unmergedFiles`、`showStage2`、`checkoutTheirs`、`rm` | child_process |
| `src/config.ts` | 路径约定、config 读写、滚动日志（Logger）、主机名 | fs, os |
| `src/sync-engine.ts` | 一次 `syncOnce()`：暂停检查→提交→fetch→merge(union+冲突副本)→push；`runDaemon()` 定时循环，永不崩溃 | git.ts, config.ts |
| `src/commands/init.ts` | 环境检查→clone→种入 .gitattributes/.gitignore→注册自启→输出集成片段 | git, platform |
| `src/commands/status.ts` | 读进程/日志/git 状态汇总一屏；update 提示 | git, platform |
| `src/commands/{sync,pause,resume,uninstall,daemon}.ts` | 其余命令 | — |
| `src/platform/index.ts` | 按 `process.platform` 选择实现，统一接口 `install()/uninstall()/isRunning()` | launchd/systemd/windows |
| `src/platform/{launchd,systemd,windows}.ts` | 三平台自启注册/注销 | child_process, fs |

## 4. 同步引擎行为（严格照 product.md §2.2 / §2.3）

```
syncOnce():
1. 存在 .knowbase-pause → 记录并跳过
2. 本地有改动 → git add -A → commit（先提交后拉取，保证 merge 面对干净工作区）
3. git fetch origin
4. 本地落后 origin/<branch> → merge
     - *.md 由 .gitattributes 的 merge=union 自动合并
     - 其余 unmerged 文件（git diff --name-only --diff-filter=U）→ 冲突副本兜底：
         本地版本 git show :2:<file> 另存为 conflict 副本（删改冲突可能不存在→容错）
         原文件取远端版本 git checkout --theirs（远端已删→git rm）
         git add 全部，合并继续
5. 本地领先 → git push；被拒（并发）→ 静默留待下轮
任一步失败 → 记日志，进程不退出，下轮重试
```

## 5. 跨平台自启（product.md §2.4）

- **macOS**：launchd LaunchAgent plist（`RunAtLoad`+`KeepAlive`）写入 `~/Library/LaunchAgents/`，`launchctl bootstrap/bootout`。
- **Linux**：systemd user service 写入 `~/.config/systemd/user/`，`systemctl --user enable --now`，并 `loginctl enable-linger`。
- **Windows**：计划任务（登录触发）`schtasks /create /sc onlogon`，指向 `knowbase daemon`。

三平台服务定义均指向 `knowbase daemon`，崩溃由服务管理器自动重启。

## 6. 测试计划（对应 product.md §四 验收标准）

- **AC2 双机并发**（vitest，本地 bare 远端 + 两个 clone）：
  - 同一 md 文件两端并发编辑 → union，双方内容均保留
  - 同一非 md 文件同一行冲突 → 生成 `.conflict-` 副本，双方内容均可找回，同步不中断
- **AC3 断网补同步**：把 remote 指向不可达地址模拟断网，期间本地持续编辑，恢复后一次 sync 补齐，无丢失
- 冲突处理容错分支：删改冲突（`:2:` 不存在）、远端删除文件
- 暂停语义：存在 `.knowbase-pause` 时不产生提交
- **真实 GitLab 实测**：对 `gitlab.deeplink.media/nodejs/knowledge-base` 真实 init + 双向 sync（用明确标记的测试文件，测后清理）
- **macOS launchd**：真实注册→确认进程被拉起→注销

## 7. 非目标（照搬 product.md §5.3）

自动更新、检索/模板/lint、PR/审批、内容治理、GUI/托盘、非 Git 后端——均不做。
