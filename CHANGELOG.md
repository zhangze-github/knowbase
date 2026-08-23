# Changelog

## 0.7.0 (2026-08-23)

- 团队 skills 分发新增 Codex 目标：真实装了 Codex（`~/.codex/` 下存在 `config.toml` / `auth.json` / `sessions` / `history.jsonl` / `logs` 之一，knowbase 自己写全局提示词顺手建出的空目录、原子写崩溃残留的临时文件、本功能自建的 `skills/` 目录都不算）的机器，每个同步周期都会额外把一份分发到 `~/.codex/skills/org-<name>/`；装/卸 Codex 后无需任何操作，下个周期自动生效/停止。
- `status` / `init` / `uninstall` 与守护进程日志按分发目标（Claude Code / Codex）分组展示。
- `SkillRemoval` 新增 `tool` / `path` 字段，记录被移除副本对应的工具与路径。
