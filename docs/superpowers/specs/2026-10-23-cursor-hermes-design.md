# Cursor / Hermes 接入

目标：按现有 Claude Code / Codex 的使用体验覆盖 Cursor 桌面版、Cursor CLI 和 Hermes，包含知识库上下文、团队 skills、周期刷新、status 和安全卸载。用户已确认 Cursor 两端均需要。

## 接入方式

- Cursor：`~/.cursor/hooks.json` 中注册官方 `workspaceOpen` hook，返回托管插件路径；插件内 `rules/knowbase.mdc` 使用 `alwaysApply: true`，两端加载同一份规则。团队 skills 写入 `~/.cursor/skills/org-*`。
- Hermes：在 `HERMES_HOME`（默认 `~/.hermes`）安装 `knowbase-context` 插件，用 `register_system_prompt_section` 注册知识库上下文。启用列表使用 YAML 语法树更新，保留其他设置和注释；保留用户的显式禁用。skills 写入该实例的 `skills/org-*`。
- 新客户端以真实配置/运行状态为安装证据，knowbase 自己的规则、插件、skills 不算安装证据。未安装时不创建它们的配置目录。后安装的新客户端重新执行 init 完成上下文接入，skills 下周期自动分发。
- 托管目录带所有权标记；同名非托管目录跳过并给出原因。个人规则、hooks、配置与 skills 不覆盖。卸载只移除本项目拥有的内容及注册项。
- Hermes 的所选实例路径持久化，避免后台服务丢失 `HERMES_HOME`。若首次为启用插件创建 config.yaml，保存其内容哈希；仅含 knowbase 注册的配置不作为安装证据，卸载时可删除，用户已修改的配置保留。
- Hermes 运行时每个插件上下文最多 4,000 字符；在行边界截断目录树并提示 grep，保留知识库路径和主要读写准则。
- 守护进程只刷新既有托管上下文，用户删除或停用后不自动重建。单端配置损坏不阻塞其他客户端。

## 备选方案

1. 为所有客户端写全局 AGENTS.md：Cursor/Hermes 不保证读取，排除。
2. 修改 Cursor 内部设置数据库、在 Hermes SOUL.md 中追加：耦合内部格式或改变个人设定，排除。
3. 官方 hook / 插件 + 原生 skills：采用。用户确认需要桌面版与 CLI；具体稳定入口由实现核验。

## 验证

先增加失败用例，再实现。覆盖安装识别、真实脚本执行、幂等、更新/删除传播、配置损坏、同名保护、用户禁用、卸载。使用本地 Docker 临时容器和独立 HOME，不挂载真实用户配置。容器内执行完整测试及 build，并通过本地 Hermes 的真实加载器和豆包模型验证上下文与 skill 可用。Cursor 使用现有 CLI 验证插件/规则入口；若无 Cursor 凭据则明确记录模型端到端测试未完成。豆包 API 密钥仅临时注入，不写入仓库和镜像。

## 官方依据

- https://cursor.com/docs/hooks （workspaceOpen 同时支持桌面版和 CLI，输出 pluginPaths）
- https://cursor.com/docs/plugins （插件 rules）
- https://cursor.com/help/customization/skills （全局 skills）
- https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins
- https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks （system prompt sections）
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
