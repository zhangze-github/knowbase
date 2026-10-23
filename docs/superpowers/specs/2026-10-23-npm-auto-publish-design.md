# npm 自动发布设计

用户选择：推送 main 自动发布；版本未变跳过。

## 方案
- 已选：GitHub Actions 监听 main，比较 package.json 与 npm registry，未发布的新版本经测试与构建后发布。
- 备选：推送版本标签触发。边界清楚，但多一步推标签，用户未选择。

## 约束
- npm Trusted Publishing / OIDC，仅授权 zhangze-github/knowbase 的 publish.yml，无长期 npm token。
- Node 24、npm >=11.5.1，GitHub 托管 runner。
- 当前 1.1.0 已存在，第一次主分支运行应测试成功并跳过发布。
- 只发布稳定版本；包名、lockfile 版本必须匹配；registry 错误和版本倒退必须失败。
- 并发发布串行，不自动修改版本、不重发旧版本。未来发布由维护者更新版本和 CHANGELOG 后推送 main。

## 验收
版本决策单测、构建、Docker 普通用户全量测试通过；main 工作流实际成功运行；npm 信任授权实际可查询。
