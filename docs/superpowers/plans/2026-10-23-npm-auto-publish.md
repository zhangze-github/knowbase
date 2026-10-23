# npm 自动发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用户推送 main 后自动发布尚未发布的新版本。

**Architecture:** GitHub Actions 测试并构建，版本检查脚本读取官方 registry；npm OIDC 授权唯一 workflow。

**Tech Stack:** GitHub Actions、Node 24、npm、Vitest、Docker。

**Spec:** docs/superpowers/specs/2026-10-23-npm-auto-publish-design.md

## Global Constraints
- main 推送触发；当前 1.1.0 不重复发布。
- 官方 npm registry、OIDC、无长期 token。
- 用户原有未跟踪文件不变。

## Review Focus
- 版本已存在时跳过，未发布且比 latest 新时发布。
- 倒退、预发布、包名与 lockfile 不符时失败。
- 认证、网络和 registry 异常不能误判为未发布。
- 并发运行串行，发布前必须先通过测试与构建。
- 工作流 npm 权限与 trusted publisher 名字一致。

### Task 1: 自动发布与验收
**Files:** .github/workflows/publish.yml、.github/scripts/check-release.mjs、test/release-check.test.ts、README.md。
**Interfaces:** releaseDecision(package, lockfile, registryMetadata) 返回 {publish, version, reason}；脚本输出 GitHub should_publish。
- [x] 写版本决策与 registry 错误测试，验证 RED。
- [x] 实现检查脚本与主分支工作流、发布文档，验证 GREEN。
- [x] Docker 普通用户运行全量测试与构建，审阅 diff。
- [x] 配置 npm trusted publisher，提交并快进 main，观察首次工作流通过且跳过已发布版本。

## 验证记录
- RED：版本检查模块尚不存在时定向测试失败。
- GREEN：新增 16 项测试通过；实际 registry 检查正确跳过 1.1.0。
- Docker：普通用户全量 17 文件 / 287 项测试通过；TypeScript 构建通过。
- 独立审阅：未发现需修复问题；工作流先构建再运行依赖 dist 的 CLI 测试。
- npm trusted publisher 已创建：`zhangze-github/knowbase` / `publish.yml`，允许 publish。
- main 已快进到包含 1.1.0 功能与本工作流的提交。
- 首次 GitHub Actions push 验收成功：构建、287 测试、pack 检查通过，OIDC 发布步骤因版本已存在而跳过。运行：https://github.com/zhangze-github/knowbase/actions/runs/39955004127 。
- 新版本真正写入 registry 的 OIDC 发布将在下一次版本递增时执行；本次未为测试另发一个 npm 版本。
