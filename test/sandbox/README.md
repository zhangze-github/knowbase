# Docker 沙盒验收

全部测试在临时容器中运行，不挂载本机 HOME、凭据或知识库。构建上下文使用 Dockerfile 专属白名单，排除工作区其他文件。`KNOWBASE_SKIP_AUTOSTART=1` 避免操作宿主自启服务。

## 完整回归

```sh
docker build -t knowbase-agent-test:local -f test/sandbox/Dockerfile .
docker run --rm --network none knowbase-agent-test:local
```

镜像构建执行 `npm ci` 和 TypeScript build，完整测试以普通用户 `node` 运行，包括真实 Git 镜像的 init/status/uninstall、只读锁、后台刷新与 skills 分发。

## 真实客户端

以下示例复用本机已有的客户端镜像；其他机器可用自身安装好客户端的镜像，通过 `AGENT_IMAGE` 指定。Hermes 镜像的源码及 venv 位置分别为 `/opt/hermes` 和 `/opt/hermes/.venv`。

```sh
docker build -t knowbase-hermes-test:local \
  --build-arg AGENT_IMAGE=agent-platform-hermes:2026-10-18 \
  -f test/sandbox/Dockerfile.agent .
docker run --rm --network none knowbase-hermes-test:local

docker build -t knowbase-cursor-test:local \
  --build-arg AGENT_IMAGE=agent-platform-cursor:2026.10.16-e3cb207 \
  -f test/sandbox/Dockerfile.agent .
docker run --rm --network none knowbase-cursor-test:local sh -c \
  'node test/sandbox/prepare-agents.mjs && node test/sandbox/cursor-loader.mjs'
```

Hermes 调用真实 `render_system_prompt_sections` / `skills_list` / `skill_view`，确认生成的插件能加载且分发的 skill 可发现、可读取。Cursor 在真实 CLI 镜像中执行 hook 并验证其 pluginPaths、规则插件和 skills 文件；这属于客户端加载入口契约测试，尚未验证模型实际消费规则，未运行桌面 GUI。

## 豆包真实模型（可选）

运行前通过环境变量设置 `ARK_API_KEY`；`ARK_BASE_URL` 为 API 根地址（例如 `https://ark.cn-beijing.volces.com/api/v3`，不要带 `/chat/completions`）。可通过 `ARK_MODEL` 选择当前账号已开通的模型。凭据只在运行时传入，勿放进 Dockerfile、构建参数或仓库。

```sh
docker run --rm -e ARK_API_KEY -e ARK_BASE_URL -e ARK_MODEL \
  knowbase-hermes-test:local sh -c \
  'node test/sandbox/prepare-agents.mjs && cd /opt/hermes && PYTHONPATH=/opt/hermes /opt/hermes/.venv/bin/python /workspace/test/sandbox/hermes-model.py'
```

模型必须根据注入的说明找到本地知识库、读取 `team.md`，并调用分发的 skill，取出两段仅存在于对应文件的验证内容；单纯 API 返回成功不能通过验收。默认 `doubao-seed-2-0-lite-260428`，最多 8 轮、每轮最多 1024 输出 tokens。

Cursor 使用自己的服务协议，普通 OpenAI Chat Completions API key / base URL 无法替代 Cursor 认证。没有 Cursor 凭据时，不把入口验证表述为模型端到端测试。
