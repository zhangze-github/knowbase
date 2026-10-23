# Cursor / Hermes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Steps use checkbox syntax for tracking.

**Goal:** 支持 Cursor 桌面版 / CLI 与 Hermes 的上下文、skills 和卸载，并在 Docker 验证。
**Architecture:** 沿用现有 Markdown 区块与 skill 分发核心；额外适配器负责客户端官方 hook/插件配置。
**Tech Stack:** TypeScript、Node >=18、YAML document API、Vitest、Docker、现有 Cursor/Hermes 镜像。
**Spec:** `docs/superpowers/specs/2026-10-23-cursor-hermes-design.md`

## Global Constraints

- 不修改用户当前全局配置，不触碰工作区原有未跟踪文件，不发布。
- skills 原有 org- 前缀、托管保护、哈希更新与删除语义不变。
- 密钥只在临时测试环境使用，不写入仓库/镜像。
- 用户显式禁用不被后台刷新撤销；同名非托管目录不覆盖。

## Review Focus

- 空的客户端目录或仅托管产物不得导致安装状态锁存。
- 异常 JSON/YAML 不被覆盖，不阻塞另一客户端。
- 用户原有 hooks、配置、注释、skills 卸载后保留。
- HERMES_HOME 自定义实例的 prompt 与 skills 一致。
- hook 命令在含空格/特殊字符路径下仍可运行，后台不复活删除内容。

### Task 1: 新客户端 skills

**Files:** `src/skills-sync.ts`, `src/agent-installations.ts`, `test/additional-agents.test.ts`
**Interfaces:** `additionalAgentHomes(home)` 返回已安装新客户端路径；现有 `skillTargets(home)` 追加对应目标。
- [x] 写安装识别、双端分发、更新/删除、同名保护及卸载用例，运行确认 RED。
- [x] 实现安装门控与 skills 目标，运行目标测试确认 GREEN。

### Task 2: 上下文与注册生命周期

**Files:** `src/agent-integrations.ts`, `src/agent-config.ts`, `test/additional-agents.test.ts`, `package.json`, `package-lock.json`
**Interfaces:** 新适配器接收渲染区块及 onlyExisting，返回现有 AgentConfigChange / Removal 结构。
- [x] 写真实 hook 执行、YAML 注释/禁用、损坏配置、碰撞、幂等、onlyExisting 与卸载测试，确认 RED。
- [x] 实现 Cursor workspaceOpen 插件和 Hermes system prompt 插件；接入 sync/uninstall。
- [x] 运行新增及现有 agent-config / skills 测试确认 GREEN。

### Task 3: Docker 验收与文档

**Files:** `test/sandbox/`, `README.md`, `CHANGELOG.md`, `src/cli.ts`, `src/commands/init.ts`
**Interfaces:** 可复跑的 Docker 沙盒脚本；真实 Hermes loader/model 测试使用临时凭据。
- [x] 文案同步到四客户端，记录自定义 home、升级接入方式、Cursor 模型测试限制。
- [x] Docker 内 build + 全量 suite + CLI init/status/uninstall 验收。
- [x] Docker Hermes 真实插件/skill 加载及豆包调用，Cursor CLI 入口 smoke test。
- [x] 审查 diff、检查无密钥、记录实际结果。

## 验证结果（2026-10-23）

- Docker 普通用户：TypeScript build 成功，16 个测试文件 / 271 项测试全部通过（含仓库根 skills 不注入提示词的回归）。
- Hermes 真实运行时：插件上下文注册、skills 发现与读取通过。
- 豆包 `doubao-seed-2-0-lite-260428`：真实 Hermes 工具调用成功读取镜像知识与分发的 skill。
- Cursor CLI `2026.10.16-e3cb207`：真实二进制、hook 执行和插件/规则/skills 文件契约通过；未执行桌面 GUI 或 Cursor 模型对话（缺 Cursor 凭据，豆包接口不能替代 Cursor 后端）。
- 独立审查发现两处 P2：生成的 Hermes 配置被误认成安装证据、后台恢复已删除入口；均增加失败回归用例后修复，全量 268/268 通过。
- 临时 API 密钥已删除，源码/测试/文档密钥扫描通过。原有无关未跟踪文件保持不变。
