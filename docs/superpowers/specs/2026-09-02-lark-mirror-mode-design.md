# knowbase 飞书镜像模式（lark mirror mode）设计

> 本文档定义 knowbase 的重大形态演进：知识库的唯一真相源从「git 仓库里的 Markdown」迁移为「飞书知识库（wiki space）」，git 仓库降级为镜像与分发层，成员本地目录变为只读镜像。
> 背景讨论、竞品调研结论见 §12。原 git 协作模式（下称「经典模式」）保留并继续支持，两种模式并存。

## 0. 决策摘要

| 决策点 | 结论 |
|---|---|
| 唯一真相源 | 飞书知识库 space。人与 agent 的写入都发生在飞书侧 |
| 链路方向 | 严格单向：飞书 → git 仓库 → 各成员本地。无任何上行 |
| git 仓库角色 | 镜像 + 版本历史/审计 + 分发媒介（成员侧复用现有下行通道） |
| exporter 部署 | 公司服务器/容器，单点，是 git 仓库唯一 writer |
| 成员侧模式识别 | 仓库内存在 `.knowbase-mirror.json` 即自动进入镜像模式，成员零配置 |
| agent 读 | grep/read 本地镜像（毫秒级、离线、省 token） |
| agent 写 | 通过 lark 工具（lark-doc / lark-wiki）直接写飞书文档，靠文件头 `feishu_url` 定位；knowbase 不为写入通道写代码 |
| 本地只读防护 | 软（prompt 规则）+ 硬（镜像文件 chmod 444）双层 |
| `skills/` 目录 | git 原生区，exporter 不触碰，不经飞书，仍走 PR 评审（见 §8） |
| 冲突模型 | 结构性消灭：每篇文档唯一写方是飞书，仓库唯一 writer 是 exporter，成员只读 |

## 1. 背景与动机

经典模式假设「人愿意直接读写本地 Markdown + git」。实际情况是：团队协作重心在飞书知识库（编辑体验、评论、移动端、非技术成员），Markdown/git 对人是负担；而 agent 恰恰相反，文件系统 grep/read 是所有 coding agent 的最大公约数。两边各有主场，knowbase 的价值定位从「git 同步守护进程」演进为「**人用飞书写、agent 用文件系统读**的桥」。

对比 MCP 直连（agent 通过飞书 MCP 实时查 API）的取舍：本地镜像胜在 token/延迟经济性、成员零鉴权配置、离线可用、跨 agent 通用；写入侧则复用 MCP/lark 工具。本设计即两条路线的混合：**读走镜像，写走飞书**。

## 2. 总体架构

```
人（飞书客户端） / agent（lark-doc / lark-wiki 工具）
        │ 写
        ▼
飞书知识库 space（唯一真相源）
        │ ① exporter：轮询 + 增量导出（服务器，单点）
        ▼
git 仓库（镜像 + 历史 + 分发；exporter 是唯一 writer）
        │ ② 成员 daemon 下行 pull（现有通道，镜像模式）
        ▼
成员本地 ~/org-kb（只读镜像；agent grep/read；chmod 444）
```

两段单向管道。任何一篇文档只有飞书一个写方，结构上不存在冲突；经典模式的 union merge、conflict copies、push-gate 在镜像模式下不参与。

## 3. 新组件：exporter（`knowbase exporter`）

### 3.1 形态与部署

- knowbase 包内新子命令 `knowbase exporter`（长驻进程），复用 `git.ts`、`Logger`、config 基建；交付 Dockerfile 与 systemd unit 示例。
- 部署于公司服务器/容器，全网唯一实例。凭据（飞书 app id/secret、git 写权限）只存在于服务器。

### 3.2 飞书侧鉴权

- 企业自建应用（bot），申请 wiki / docx / drive 读权限；将 bot 加为知识库 space 成员。
- 使用 tenant access token，不依赖任何个人账号。

### 3.3 同步循环（默认间隔 5 分钟，可配）

1. 分页拉取 wiki space 节点树（可配置只导出某个子树根节点）。
2. 与仓库内状态清单 `.knowbase-mirror.json` 对比（`node_token → { path, obj_edit_time, content_hash }`），得出增 / 改 / 移 / 删四类变更。
3. 变更文档：读取 docx 块结构 → 转换为 Markdown → 写入文件（frontmatter 见 §3.5）。
4. 目录映射：节点树 → 目录树。标题清洗为合法文件名（非法字符替换、重名追加短后缀）；**`node_token` 是文件的稳定身份**——改标题产生 `git mv` 而非删建，保住 git 历史。
5. 库内链接改写：正文中指向本 space 其他文档的飞书链接，改写为「相对本地路径 +（飞书原链）」双链形式，agent 可在本地顺链续读。
6. 有损内容降级：画板、内嵌多维表格/电子表格等不可转换块 → 占位说明 + 原文飞书链接。
7. `git add/commit/push`。commit 信息带变更清单（`mirror: +2 ~3 -1 …`）。
8. 更新 `.knowbase-mirror.json`（该文件本身随仓库分发，同时充当成员侧模式识别标记，见 §4.1）。

### 3.4 对账与新鲜度

- 低频全量对账（默认每日一次）：全量重算 hash 校验增量漂移，发现不一致即修复并记日志。
- `.knowbase-mirror.json` 记录 `last_sync_at`、`last_full_check_at`，供成员侧 `status` 展示新鲜度。

### 3.5 导出文件 frontmatter

```markdown
---
feishu_url: https://xxx.feishu.cn/wiki/<node_token>
title: <文档标题>
synced_at: <ISO8601，导出时刻>
managed_by: knowbase-mirror
---
```

- `feishu_url` 是 agent 的修改入口（lark 工具可直接解析 wiki URL）。
- `synced_at` 是新鲜度声明。
- 其余定位信息（node_token、obj_token 等）留在 `.knowbase-mirror.json`，不污染文件头。

### 3.6 错误哲学（沿用现有 daemon）

- 循环 never throw、never exit；单篇导出失败记日志、跳过、下轮重试。
- 飞书 API 限流：指数退避。
- push 失败：下轮重试（服务器侧无 push-gate 需求，失败即告警日志）。

### 3.7 可选项：index.md 骨架生成

根 `index.md` 在飞书中维护（正常镜像下来并照常注入 prompt block）。当飞书侧不存在根 index 文档时，exporter 可基于节点树自动生成一份目录骨架（标注 `auto-generated`），保证 KB 触发层（§9）始终存在。默认开启，可关。

## 4. 成员侧：镜像模式（daemon 改动）

### 4.1 自动识别，成员零感知

- daemon 每周期检测仓库内是否存在 `.knowbase-mirror.json`：存在 → 镜像模式；不存在 → 经典模式。
- 两种模式并存于同一代码库，经典模式行为完全不变，老用户不受影响。仓库从经典切换为镜像后，存量成员的 daemon 自动跟随，无需重装。

### 4.2 镜像模式下的行为差异

| 环节 | 经典模式 | 镜像模式 |
|---|---|---|
| 上行（commit/push） | 有 | **无** |
| union merge / conflict copies | 有 | 不参与 |
| push-gate | 有 | 不参与 |
| watcher 上行触发 | 有 | 仅用于检测「本地被改」 |
| 下行 pull | 60s 轮询 | 不变 |
| prompt 注入 / index.md 快照 | 有 | 有（规则更新见 §5） |
| skills 分发 | 有 | 有（来源见 §8） |

### 4.3 本地改动处理（只读的执行）

- **硬防护**：daemon 每次 pull 更新后，将镜像内 md 文件设为只读（POSIX 444 / Windows read-only 属性）。agent 的 Edit/Write 当场报权限错误——失败即引导，agent 回头读 frontmatter 走飞书通道。daemon 自身更新前先解锁，更新后重新上锁。`skills/`、`.knowbase-mirror.json`、`.gitignore` 等仓库原生文件不在锁定范围。
- **兜底**：每周期 `git status` 发现脏文件 → 改动内容全文存入日志目录留底 → `git checkout` + `git clean` 恢复 → `status` 报警告。原则不变：不静默丢内容（留底），不阻塞等待人。

### 4.4 status 扩展

镜像模式下 `knowbase status` 额外展示：镜像新鲜度（`last_sync_at` 距今）、上次全量对账时间、本周期是否发生过本地改动回滚。exporter 停摆（`last_sync_at` 超过阈值，默认 30 分钟）计为异常，非零退出。

## 5. prompt block 更新（`agent-config.ts`）

镜像模式下注入块的读写规则改为：

```
- 本目录是飞书知识库的只读镜像，禁止直接编辑其中任何文件。
- 要修改某篇知识：取该文件头部的 feishu_url，用飞书文档工具（lark-doc）编辑对应文档。
- 编辑前先用 lark-doc 读取该文档的最新内容——本地镜像可能落后几分钟，不要基于旧版整篇覆盖。
- 要新增知识：用 lark-wiki 在「Agent 沉淀」目录下创建文档（URL：<配置项>）。
- 修改会在几分钟内自动回流到本目录；同一会话内如需引用刚写入的内容，以写进飞书的版本为准。
```

其中「编辑前先读最新版」是本闭环唯一的数据安全关键点：防止 agent 拿过期镜像整篇覆盖他人刚写入的内容。「Agent 沉淀」目录的 node URL 作为仓库级配置存于 `.knowbase-mirror.json`，由 exporter 侧配置写入。

## 6. agent 写入通道

- **零代码**：依赖成员机器上已有的 lark 工具链（lark-doc / lark-wiki），knowbase 只负责 §5 的引导与 §3.5 的定位信息。
- 未配置 lark 工具的成员：agent 只读，写入建议由人工在飞书完成。`init` 输出与 README 说明该前置条件。

## 7. 一次性迁移（`knowbase migrate-to-lark`）

- 独立一次性命令：遍历现有 md 仓库 → Drive 导入任务（md → docx）→ 按目录结构创建 wiki 节点树挂载。
- 同一 git 仓库原地转为镜像仓库（exporter 首轮全量导出即完成切换），git 历史延续，保留「迁移前后」完整脉络。
- 导入轻微有损，迁移完成后人工抽查；命令输出逐文件导入结果清单。
- `skills/` 目录不迁移（见 §8）。

## 8. `skills/` 目录：git 原生区

- exporter 视 `skills/` 为保留目录，不覆盖、不删除、不镜像；其内容不经飞书，直接在 git 仓库中以 PR 维护。
- 理由（知识分层模型）：skill = 知识正文 + 常驻 context 的触发器（description），触发预算稀缺，需要评审纪律——git PR 是晋升评审的天然关卡；KB 是海量长尾自由沉淀区——适合飞书。
- **晋升通道**（运营约定，不写代码）：当某篇 KB 文档被 agent 高频需要或某操作反复出错，人工提炼为 SKILL.md 提交 PR 进 `skills/`。写入 README 用户文档。
- 镜像模式下 `skills-sync.ts` 行为完全不变。
- 注意：exporter 是仓库唯一 writer 的表述在此放宽为「唯一**自动** writer」——`skills/` 与仓库配置文件的人工 PR 合并是允许的第二写入路径，二者路径集合不相交，无冲突。

## 9. 知识触发层（三级梯度）

| 层 | 载体 | 触发方式 | 容量 |
|---|---|---|---|
| skill description | `skills/`（git） | 精确自动触发 | 几十条，精选 |
| index.md 注入块 | 飞书根 index（镜像+注入） | 粗粒度导航 | 一张地图，8KB 截断 |
| KB 正文 | 飞书 → 镜像 | 被动 grep/检索 | 无限 |

现有 `INDEX_MAX_BYTES` 截断、子目录 index 导航约定不变。

## 10. 边界与已知取舍

- **权限打平**：飞书侧的细粒度可见性在镜像后失效——所有能 clone 仓库的人可见全部导出内容。本方案前提是该知识库对团队全员等权可见；「部分人可见」内容不得放入被镜像的 space/子树。此条写入 README 显著位置。
- **不做双向同步 / 块级写回**：有损转换 + 飞书无 merge 概念，自建双向的复杂度与体验上限不成比例。
- **不做实时**：分钟级延迟（exporter 间隔 + 成员 pull 间隔），团队知识库场景可接受。
- **导出有损**：画板、内嵌表格等降级为链接占位（§3.3-6）。
- 检索增强（语义索引等）仍属另一个工具的职责（参见 product.md 非目标），本设计不改变该边界。

## 11. 测试策略

- **转换器**（docx 块 → md）：单测 + 快照测试，覆盖各块类型与降级路径。飞书 API 以录制的响应 fixture 模拟。
- **节点树 diff**（增/改/移/删 + git mv 判定）：纯函数单测。
- **成员侧镜像模式**：复用现有 vitest 本地 bare 仓库基建——bare 仓库内放置 `.knowbase-mirror.json` 即可驱动模式切换；覆盖：自动识别、上行关闭、只读上锁/解锁、本地改动留底回滚、status 输出。
- **exporter 循环**：never-throw 与限流退避的行为测试（注入故障的 fake client）。

## 12. 竞品与参考实现

| 项目 | 与本设计的关系 |
|---|---|
| [longbridge/feishu-pages](https://github.com/longbridge/feishu-pages) | exporter 最直接的参考：节点树遍历、docx→md 转换、图片处理、链接改写均有现成实现（TS，303★） |
| [elog](https://github.com/LetTTGACO/elog) | 「云文档为源 → md → git」链路的规模化验证；多平台适配层设计可参考（1.8k★） |
| [basic-memory](https://github.com/basicmachines-co/basic-memory) / [GitKB](https://gitkb.com/) / [OpenKnowledge](https://openknowledge.ai/) / [MDflow](https://mdflow.cz/blog/team-knowledge-base-for-ai-agents) | 同赛道（agent 团队知识库），验证需求真实性；均假设人直接写 md/git——「飞书为源」是本项目差异位 |
| [ruler](https://github.com/intellectronica/ruler) | 多 agent 目标适配注册表模式参考 |
| [larksuite/lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp) | MCP 直连替代路线；本设计以「读镜像、写飞书」吸收其写入侧 |

差异化定位：①「人用飞书写、agent 用文件系统读」的桥；② install-and-forget 守护进程运维（autostart、自愈、status）；③ 三级知识触发层（skill 分发 + index 注入 + 镜像 grep）。
