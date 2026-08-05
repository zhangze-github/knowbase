# push 无权限时的熔断与只读降级（v0.5.0）

> 前置：[knowbase 实现设计](2026-07-29-knowbase-design.md) §2.2 同步周期。本文档描述如何让守护进程识别「重试也不会成功」的 push 失败，停止无限重试，并降级为一个可用的只读模式。

## 1. 问题

`syncOnce` 对 push 失败一律「记一条日志，下周期重试」（[sync-engine.ts:203-215](../../../src/sync-engine.ts)），不区分失败原因。对没有仓库写权限的成员，后果是：

- 每 60 秒（以及每次文件保存触发防抖后）撞一次远端，永不停止；
- `knowbase.log` 被同一条错误灌满，真正的异常淹没在噪声里；
- 用户侧毫无信号——`status` 只显示「本地领先 N 个提交」，看不出这些提交**永远推不出去**。

`git.push` 已有的 `rejected` 分类只覆盖 non-fast-forward 竞争，而 GitLab 保护分支拒绝时输出里**同时**包含 `not allowed to push` 和 `[remote rejected]`，会被误判为并发竞争，落进「下周期先合并再推」的循环——这是当前无限重试最容易命中的真实路径。

## 2. 目标与非目标

**目标**：把 push 失败分成「重试有意义」和「重试无意义」两类；后者熔断，只保留低频探测；权限补上后自动恢复，用户零操作。无权限的成员降级为一个语义清晰、仍然有用的只读模式。

**非目标**：

- **不停止 commit / fetch / merge**。熔断只掐 push。
- **不做递增退避**。固定 5 分钟一次探测（用户决策，见 §4）。
- **不阻断 init**。没有写权限也允许接入，只读同样是合法用法。
- **不引入通知机制**。可见性只做到 `status` 和日志，不弹系统通知。

## 3. 失败分类

在 [git.ts](../../../src/git.ts) 的 `PushOutcome` 上新增 `denied: boolean`，表示凭证 / 权限 / 服务端策略拒绝——重试必然同样失败。

判定基于 `(stderr + stdout).toLowerCase()` 的关键词匹配，覆盖 GitHub / GitLab、SSH / HTTPS 两两组合：

| 关键词 | 典型来源 |
|---|---|
| `permission denied` | SSH publickey 失败；GitHub `Permission to X denied to Y` |
| `authentication failed` | HTTPS 凭证错误 |
| `could not read username` / `could not read password` | HTTPS 无凭证且 `GIT_TERMINAL_PROMPT=0` |
| `403` / `forbidden` | HTTPS 无写权限 |
| `401` / `unauthorized` | 凭证过期 |
| `access denied` | 通用 |
| `you are not allowed to push` | GitLab 明确文案 |
| `pre-receive hook declined` / `protected branch` | GitLab / GitHub 保护分支 |
| `repository not found` | GitHub 对无权限私有库的伪装 404 |

**判定顺序：`denied` 先于 `rejected`。** 理由见 §1——保护分支的输出两类关键词都命中，先判 `rejected` 就会退回无限重试。

其余非零退出（网络超时、DNS、远端 5xx）既不是 `denied` 也不是 `rejected`，维持现状：记日志、下周期重试。这类失败重试是有意义的，不该熔断。

**前置修改**：`nonInteractiveEnv()`（[git.ts:13](../../../src/git.ts)）当前设了 `GIT_TERMINAL_PROMPT=0` 但没有固定 locale。git 自身的部分错误文案（如 `fatal: 无法读取远程仓库`）在中文 locale 下会被本地化，导致关键词失配。需一并加上 `LC_ALL=C`，让所有分类都建立在稳定的英文输出上。

## 4. 熔断器

新文件 `src/push-gate.ts`，一个只负责「现在该不该试 push」的独立单元，时钟可注入。

**状态**：`blocked: { since: number; reason: string; nextProbeAt: number } | null`。

**接口**：

- `shouldAttempt(now): boolean` —— 未熔断恒 `true`；熔断中仅当 `now >= nextProbeAt` 返回 `true`（放行一次探测）。
- `record(outcome, now): void` —— `denied` 则进入 / 维持熔断，`nextProbeAt = now + 5min`；`ok` 则清空状态；其余分类不改变熔断状态。
- `snapshot()` —— 供 daemon 写入 `DaemonState`。

**探测间隔固定 5 分钟**，不做递增退避。权限授予通常是管理员的一次性人工动作，5 分钟的恢复延迟可接受；固定间隔也让 `status` 里「下次重试时间」这个提示始终准确、易解释。

**生命周期**：熔断状态活在守护进程内存里，随进程重启清空——重启后先试一次 push，失败再熔断，代价是一次多余请求，换来无需持久化状态、也无需处理状态文件损坏。

**前台 `knowbase sync` 无视熔断**：通过 `SyncDeps` 传入 `forcePush: true`。用户主动跑这条命令就是想立刻知道现在通不通，让他等 5 分钟窗口是反直觉的。

## 5. 熔断期间的同步行为

`syncOnce` 第 5 步改为先问熔断器：

```
shouldPush && (deps.forcePush || gate.shouldAttempt(now))
```

commit、fetch、merge 三步**完全不受影响**。没有写权限的成员因此得到一个干净的只读模式：本地改动仍然安全提交在本机（不丢），团队的更新照常拉取合并。权限补上后，下一次探测成功即自动恢复推送，积压的提交一次推完。

**日志只在状态翻转时写**：

- 进入熔断：`push 无权限，已暂停推送（每 5 分钟自动重试一次）：<原因首行>`
- 恢复：`push 权限已恢复，继续推送`

静默探测失败不写日志。这是本设计的一个硬要求——每 60 秒一条错误的日志噪声本身就是要修的问题之一。

`SyncResult` 新增 `pushDenied: boolean` 与 `pushSkipped: boolean`，供 daemon 更新状态。

## 6. 状态可见性

`DaemonState` 新增：

```ts
pushBlocked?: { since: string; reason: string; nextProbeAt: string };
```

`status` 在检测到该字段时输出一条醒目提示，并计入 anomalies（使退出码非零，便于监控脚本捕获）：

```
⚠ 无 push 权限：本地 3 个提交只在本机，未同步给团队。
  原因：GitLab: You are not allowed to push code to this project.
  下次自动重试：14:35。补上权限后会自动恢复，无需手动操作。
```

提交数复用已有的 `git.aheadCount`。「无需手动操作」这句是刻意的：它把用户从「我是不是该做点什么」的焦虑里摘出来，符合「安装即忘」。

## 7. init 预检

`init` 现在只跑 `git ls-remote`，那**只验证读权限**——只读成员会一路成功接入，然后默默推不上去。

在 clone 完成后新增一次 `git push --dry-run origin HEAD:<branch>`，走 §3 同一套分类。`--dry-run` 仍会向服务端发起 `git-receive-pack` 协商，鉴权在该阶段发生，因此即使本地无新提交也能真实反映写权限。

判为 `denied` 时**警告但不阻断**，init 继续完成（配置、自启、agent 提示词照常）：

```
⚠ 你对该仓库没有 push 权限，knowbase 将以只读模式运行：
  能拉到团队的更新，本地改动只提交在本机、不会同步出去。
  需要写权限请联系仓库管理员，补上后自动恢复，无需重新 init。
```

同时，既有的「种入 union / 忽略规则」那次真实 push 若因权限失败，不再输出误导性的「守护进程会自动重试」，改为指向上面这条只读模式说明。

## 8. 测试

现有测试以本地 bare repo 作 origin（`test/helpers.ts` 的 `makeOrigin`）。给 bare repo 装一个 `pre-receive` 钩子、输出 GitLab 原文并退出 1，即可**真实**构造「有读权限、无写权限」，无需 mock git。

三层覆盖：

1. **分类函数单元测试**：GitHub / GitLab × SSH / HTTPS 的真实 stderr 文案各一例，断言 `denied`；non-fast-forward 断言 `rejected` 且非 `denied`；保护分支那条同时含两类关键词的，断言 `denied` 优先；网络超时断言两者皆否。
2. **`PushGate` 单元测试**（注入时钟）：首次 `denied` 立即熔断；4 分 59 秒时 `shouldAttempt` 为 false，5 分 01 秒为 true；探测再失败则窗口顺延 5 分钟；`ok` 后立即解除。
3. **集成测试**：装上拒绝钩子后连跑多轮 `syncOnce`，断言只发生一次 push 尝试；断言本地 commit 与从远端 merge 仍正常；断言日志中该错误只出现一次；摘掉钩子并推进时钟后，断言自动恢复推送。

`status` 的输出断言并入现有 `cli.test.ts`。

## 9. 已知局限

- 关键词匹配依赖托管平台的英文输出。`LC_ALL=C`（§3）能固定 git 自身的文案，但 `remote:` 前缀那部分由服务端产生，不受客户端 locale 控制——若某平台返回中文拒绝信息，分类会失效。
- 自建 Git 服务若返回完全非常规的拒绝文案，会落进「网络类失败」分支继续重试。这是安全的降级方向：宁可多重试，不可把可恢复的失败误判成永久失败。
- 熔断状态不持久化（§4），守护进程反复重启会绕过 5 分钟窗口。正常运行下服务管理器不会频繁重启进程，不额外处理。
