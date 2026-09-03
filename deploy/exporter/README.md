# knowbase Lark Exporter 部署准备

本文档指导如何部署 `knowbase exporter`，将飞书知识库单向导出到 Git 仓库，作为团队知识库的真相源。

## 操作步骤

### ① 创建企业自建应用并获取凭证

1. 登录[飞书开放平台](https://open.feishu.cn/)
2. 创建**企业自建应用**（不是三方应用）
3. 记下 **App ID** 和 **App Secret**（后续需要）
4. 在应用的「版本管理与发布」中完成初稿创建

### ② 申请权限并发布应用版本

在应用的「权限管理」页面，申请以下权限：

- `wiki:wiki` 或 `docx:document:readonly`（知识库/文档读权限）
- `drive:drive` - 读权限（驱动器读权限，用于访问文档）

申请后，进入「版本管理与发布」，点击**发布**将应用设为可用状态。

### ③ 将应用 bot 加为知识库 space 成员（最容易遗漏的一步！）

⚠️ **这是最容易遗漏但最关键的一步** ⚠️

应用创建后，会自动生成一个 bot 身份。你需要：

1. 打开你想导出的飞书知识库 space
2. 进入 space 设置 → **成员管理**
3. **邀请你的应用 bot 作为成员**（通常应用名称就是 bot 名称）
4. 分配至少「可读」权限
5. 确认邀请生效

应用 bot **没有 space 成员身份，exporter 无法访问文档**，即使应用有权限。

### ④ 准备 Git 仓库与推送凭证

1. 在 GitHub / GitLab 等创建一个**空仓库**（或已有仓库的新分支）
2. 获取推送凭证：
   - **Deploy Key**（推荐）：SSH 公钥，只有推送权限
   - **Personal Access Token (PAT)**：用户级令牌，权限更广
   - **HTTPS 用户名密码**（不推荐）：明文存储风险高

记下仓库的 URL（Git SSH 地址或 HTTPS 地址）。

### ⑤ 本机冒烟验证（单次导出）

在本机运行 exporter 进行单次验收，确保整个流程可用。

导出到本地目录：

```bash
export KNOWBASE_LARK_APP_ID="your-app-id"
export KNOWBASE_LARK_APP_SECRET="your-app-secret"
export KNOWBASE_LARK_SPACE="https://your-org.feishu.cn/wiki/space/your-space-id"

# 初次导出，--once 表示单次运行后退出
knowbase exporter \
  --repo ~/temp-repo \
  --space "$KNOWBASE_LARK_SPACE" \
  --once
```

**验收标准**：

- 导出完成后，`~/temp-repo` 目录中出现 markdown 文件（`.md` 文件）
- **关键检查**：打开任意一个导出的 `.md` 文件，顶部应该有 YAML frontmatter，**第一行必须是** `feishu_url: <URL>`
  
  示例：
  ```markdown
  ---
  feishu_url: https://your-org.feishu.cn/wiki/wikcn...
  title: "文档标题"
  ---
  # 正文开始
  ```

若验收失败：
- 检查应用凭证是否正确
- **最常见原因**：应用 bot 未被加为 space 成员（见步骤③）
- 查阅 exporter 日志定位具体错误

### ⑥ 常驻部署

选择下列一种方案部署 exporter 为后台守护进程。

#### 方案 A：Docker 容器

前置：已安装 Docker 和 docker-compose。

**第一步**：准备 `.env` 文件（存放在可控位置，如 `~/.knowbase-exporter.env`）

```bash
KNOWBASE_LARK_APP_ID=your-app-id
KNOWBASE_LARK_APP_SECRET=your-app-secret
KNOWBASE_LARK_SPACE=https://your-org.feishu.cn/wiki/space/your-space-id
KNOWBASE_MIRROR_REPO_URL=git@github.com:your-org/knowledge-base.git
```

**第二步**：准备 SSH 凭证（如果使用 SSH）

如果仓库 URL 是 SSH 形式（`git@github.com:...`），需要将 SSH 私钥挂进容器：

```bash
# 建立容器内 git 用户的 .ssh 目录
mkdir -p ~/.ssh
# 复制你的 deploy key 私钥到该位置（权限 600）
cp /path/to/deploy-key ~/.ssh/id_rsa
chmod 600 ~/.ssh/id_rsa
```

**第三步**：构建 Docker 镜像

```bash
docker build -t knowbase-exporter:latest deploy/exporter/
```

**第四步**：运行 Docker 容器

```bash
docker run -d \
  --name knowbase-exporter \
  --restart always \
  --env-file ~/.knowbase-exporter.env \
  -v knowbase-repo:/data/repo \
  -v ~/.ssh:/root/.ssh:ro \
  knowbase-exporter:latest
```

或使用 docker-compose（创建 `docker-compose.yml`）：

```yaml
version: '3.8'
services:
  exporter:
    build: .
    restart: always
    environment:
      - KNOWBASE_LARK_APP_ID=${KNOWBASE_LARK_APP_ID}
      - KNOWBASE_LARK_APP_SECRET=${KNOWBASE_LARK_APP_SECRET}
      - KNOWBASE_LARK_SPACE=${KNOWBASE_LARK_SPACE}
      - KNOWBASE_MIRROR_REPO_URL=${KNOWBASE_MIRROR_REPO_URL}
    volumes:
      - knowbase-repo:/data/repo
      - ~/.ssh:/root/.ssh:ro
volumes:
  knowbase-repo:
```

启动：

```bash
docker-compose up -d
```

#### 方案 B：systemd 服务（Linux）

**第一步**：创建 knowbase 用户（非 root）

```bash
sudo useradd -r -s /bin/false knowbase
sudo mkdir -p /var/lib/knowbase
sudo chown knowbase:knowbase /var/lib/knowbase
```

**第二步**：准备环境文件

创建 `/etc/knowbase/exporter.env`（权限 600，仅 knowbase 用户可读）：

```bash
sudo tee /etc/knowbase/exporter.env > /dev/null <<EOF
KNOWBASE_LARK_APP_ID=your-app-id
KNOWBASE_LARK_APP_SECRET=your-app-secret
KNOWBASE_LARK_SPACE=https://your-org.feishu.cn/wiki/space/your-space-id
EOF
sudo chmod 600 /etc/knowbase/exporter.env
sudo chown knowbase:knowbase /etc/knowbase/exporter.env
```

**第三步**：预 clone 镜像仓库

systemd 服务的 ExecStart 直接调用 knowbase exporter，不像 Docker entrypoint 那样自动 clone。需要提前准备好仓库：

```bash
# 以 knowbase 用户身份 clone 仓库
sudo -u knowbase git clone git@github.com:your-org/knowledge-base.git /var/lib/knowbase/repo

# 配置该用户的 git 身份和推送凭证
sudo -u knowbase git -C /var/lib/knowbase/repo config user.name "knowbase-exporter"
sudo -u knowbase git -C /var/lib/knowbase/repo config user.email "exporter@knowbase.local"

# 如果使用 SSH 推送，配置 SSH key（或使用 deploy key）
# 例如：将私钥复制到 knowbase 用户的 ~/.ssh/
sudo mkdir -p /var/lib/knowbase/.ssh
sudo cp /path/to/deploy-key /var/lib/knowbase/.ssh/id_rsa
sudo chmod 600 /var/lib/knowbase/.ssh/id_rsa
sudo chown -R knowbase:knowbase /var/lib/knowbase/.ssh
```

若使用 PAT 或 HTTPS 凭证，配置 `~/.config/git/credentials` 或 `.gitconfig`：

```bash
# 或者使用 git 凭证存储（推荐用于 HTTPS）
sudo -u knowbase git config --global credential.helper store
# 然后在首次 push 时输入凭证
```

**第四步**：安装 systemd 单元文件

```bash
sudo cp knowbase-exporter.service /etc/systemd/system/
sudo systemctl daemon-reload
```

**第五步**：启动服务

```bash
sudo systemctl enable knowbase-exporter    # 开机自启
sudo systemctl start knowbase-exporter     # 立即启动
sudo systemctl status knowbase-exporter    # 查看状态
```

查看日志：

```bash
sudo journalctl -u knowbase-exporter -f    # 实时日志
sudo journalctl -u knowbase-exporter -n 50 # 最近 50 行
```

### ⑦ 成员侧操作说明（几乎零配置）

部署后，团队成员侧的接入流程：

1. 仓库根目录已自动生成 `.knowbase-mirror.json`（exporter 首次运行时生成）
2. 任何成员执行 `knowbase init <repo-url>`
3. knowbase 自动检测到 `.knowbase-mirror.json`，**自动进入镜像模式**
4. **成员无需任何额外配置**，后台守护进程自动感知

**镜像模式的表现**：

- 本地知识库自动设为只读（防止意外编辑）
- 所有修改指向飞书：打开文件顶部 `feishu_url` 链接，在飞书编辑
- 新增知识：在飞书创建文档
- 本地改动会在下个同步周期被 git reset，不会推送到仓库

详见主 README.md「飞书镜像模式」章节。

---

## 故障排查

| 问题 | 排查步骤 |
|------|--------|
| Exporter 启动失败 | 检查 App ID/Secret；查看日志（Docker: `docker logs knowbase-exporter`；systemd: `journalctl -u knowbase-exporter`） |
| 文档导出为空 | 确认应用 bot 已加为 space 成员；检查飞书权限是否已发布；确认 `KNOWBASE_LARK_SPACE` URL 正确 |
| 推送到 Git 失败 | 检查仓库 URL 和 SSH/PAT 凭证；确保凭证有推送权限 |
| 导出的 frontmatter 缺少 `feishu_url` | 更新 knowbase 到最新版本 |

---

## 环境变量参考

| 变量 | 是否必需 | 说明 |
|------|---------|------|
| `KNOWBASE_LARK_APP_ID` | 是 | 飞书应用 App ID |
| `KNOWBASE_LARK_APP_SECRET` | 是 | 飞书应用 App Secret |
| `KNOWBASE_LARK_SPACE` | 是 | 知识库 space URL（如 `https://org.feishu.cn/wiki/space/123`） |
| `KNOWBASE_MIRROR_REPO_URL` | 仅初次 | Git 仓库 URL，首次 clone 时必需；之后可省略 |
| `KNOWBASE_EXPORTER_EXTRA_ARGS` | 否 | 传递给 `knowbase exporter` 的额外参数（如 `--interval 300` 覆盖默认同步间隔） |
| `KNOWBASE_LARK_ENDPOINT` | 否 | 飞书 API 端点，不指定时默认使用国内 |

---

## 相关文档

- 主 README.md — knowbase 全功能文档与快速开始
- [飞书开放平台](https://open.feishu.cn/) — 应用创建与权限申请
- 产品设计文档 — 镜像模式、exporter 架构深度阅读
