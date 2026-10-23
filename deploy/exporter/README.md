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

`--repo` 必须指向一个**已 clone 的镜像仓库根目录**本身（exporter 会校验，指向非仓库目录
或仓库内的子目录都会直接报错退出）。冒烟验证也需 clone 步骤④准备好的真实镜像仓库，
并具有推送权限；每轮导出前会先拉取远端，只有 `git init`、没有 `origin` 的目录不能运行：

```bash
export KNOWBASE_LARK_APP_ID="your-app-id"
export KNOWBASE_LARK_APP_SECRET="your-app-secret"
export KNOWBASE_LARK_SPACE="https://your-org.feishu.cn/wiki/space/your-space-id"

# 替换为步骤④准备好的镜像仓库地址；不要与正在运行的 exporter 同时写入同一分支
git clone git@github.com:your-org/knowledge-base.git ~/temp-repo

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

- **首次真实运行务必额外检查**：若知识库中存在带 @文档引用（mention_doc）的页面，导出后
  打开对应 `.md` 确认引用处出现了「本地相对路径 + 飞书原链接」的双链形式，而不是退化成
  单个飞书链接——飞书对 wiki 文档的 mention 引用有时用的是 obj_token 而非 node_token，
  这类命名空间差异只有跑真实数据才能验出来。

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

凭证仅通过环境文件或 Git credential helper 提供；不要放进命令行、额外参数或仓库 URL。
运行前执行 `chmod 600 ~/.knowbase-exporter.env`。

**第二步**：准备 SSH 凭证（如果使用 SSH）

如果仓库 URL 是 SSH 形式（`git@github.com:...`），需要将 SSH 私钥挂进容器。

⚠️ **不要直接复制到 `~/.ssh/`**：容器以 root 运行、`docker run` 会把宿主机目录整个
只读挂载为容器内的 `/root/.ssh`，如果这个宿主机目录就是你本机日常使用的 `~/.ssh`，
`id_rsa` 这个文件名很可能与你自己的个人 SSH 私钥重名/混用。改用一个专用目录，只放
这一份 deploy key：

```bash
# 建立专用目录，只存放这个 exporter 用的 deploy key
mkdir -p ~/knowbase-exporter-ssh
# 复制你的 deploy key 私钥到该位置（权限 600）
cp /path/to/deploy-key ~/knowbase-exporter-ssh/id_rsa
chmod 600 ~/knowbase-exporter-ssh/id_rsa
# 预置 known_hosts：容器内 .ssh 是只读挂载（-v ...:/root/.ssh:ro），ssh 首次连接时
# 无法交互式确认并写入 known_hosts，必须提前在宿主机上写好（以 GitHub 为例，
# 按实际托管方替换域名）
ssh-keyscan github.com >> ~/knowbase-exporter-ssh/known_hosts
```

**第三步**：构建 Docker 镜像

```bash
docker build --build-arg KNOWBASE_VERSION=1.1.2 -t knowbase-exporter:1.1.2 deploy/exporter/
```

**第四步**：运行 Docker 容器

```bash
docker run -d \
  --name knowbase-exporter \
  --restart always \
  --env-file ~/.knowbase-exporter.env \
  -v knowbase-repo:/data/repo \
  -v ~/knowbase-exporter-ssh:/root/.ssh:ro \
  knowbase-exporter:1.1.2
```

或使用 docker-compose（创建 `docker-compose.yml`）：

```yaml
version: '3.8'
services:
  exporter:
    build:
      context: ./deploy/exporter
      args:
        KNOWBASE_VERSION: "1.1.2"
    restart: always
    environment:
      - KNOWBASE_LARK_APP_ID=${KNOWBASE_LARK_APP_ID}
      - KNOWBASE_LARK_APP_SECRET=${KNOWBASE_LARK_APP_SECRET}
      - KNOWBASE_LARK_SPACE=${KNOWBASE_LARK_SPACE}
      - KNOWBASE_MIRROR_REPO_URL=${KNOWBASE_MIRROR_REPO_URL}
    volumes:
      - knowbase-repo:/data/repo
      - ~/knowbase-exporter-ssh:/root/.ssh:ro
volumes:
  knowbase-repo:
```

启动：

```bash
docker-compose up -d
```

Dockerfile 默认安装 `knowbase@1.1.2`，升级时显式修改构建参数和镜像标签；不会自动安装 npm latest。

**健康检查与单写者约束**

镜像内置健康探针，每 30 秒读取 `$XDG_CONFIG_HOME/knowbase/exporter-health.json`，未设置
XDG 时使用 `$HOME/.config/knowbase/exporter-health.json`。也可用
`KNOWBASE_EXPORTER_HEALTH_FILE` 指定路径。状态包含 `started_at`、`last_cycle_at`、
`last_success_at`、`last_error`；每次进程启动重建状态，只有无错误且已成功推送的周期推进
`last_success_at`。文件缺失/损坏、最近周期报错、启动后尚未成功推送，或最后成功推送超过
`KNOWBASE_EXPORTER_HEALTH_MAX_AGE_SECONDS`（默认 600 秒）时，探针失败。
同步间隔或正常周期耗时较长时，相应增大该值。

通过 `docker inspect --format '{{json .State.Health}}' knowbase-exporter` 查看结果。
Docker 的 `unhealthy` 状态只用于诊断，`--restart always` **不会因此重启**仍在运行的容器；
探针不会终止进程，也未配置任何告警通知。需要通知时，另行接入监控系统。

入口在首次 clone 前锁定 `/data/repo` 的目录 inode，并持锁直到 exporter 退出。
共享同一 Docker volume 的第二个实例会直接报错退出；无需在空目录中放置会阻止 clone 的锁文件。
该锁不协调不同仓库副本、不同主机或远端写入者，部署时仍须保证**每个镜像分支只有一个 exporter**。
运行中不要删除或替换被锁的目录。

初次 clone 默认限制为 120 秒（`KNOWBASE_EXPORTER_CLONE_TIMEOUT_SECONDS` 可调整），超时先
发送 TERM，10 秒后仍未退出则 KILL。后续 Git fetch/merge/push 各限制 60 秒；HTTP 单次请求
（含 token 获取与响应体读取）默认 30 秒，超时中止请求。429 最多重试 5 次，重试等待仍按
服务端 `x-ogw-ratelimit-reset` 执行，不能把 30 秒理解为整个同步周期的上限。

已有本地提交和远端提交分叉时，保留仓库卷并正常重启：exporter 会 fetch 后 merge，再推送，
无需删除本地提交或 force push。若确有内容冲突，先停掉 exporter，检查日志并在保留本地工作与
提交的前提下人工解决冲突、提交后重启；不要用 reset --hard 清理未核实的改动。

#### 方案 B：systemd 服务（Linux）

**第一步**：创建 knowbase 用户（非 root）

`-d /var/lib/knowbase -m` 缺一不可：`-d` 把该用户 passwd 记录里的 HOME 设为
`/var/lib/knowbase`，`-m` 实际创建这个目录。下面第三步会把 git 仓库、SSH key、
`.gitconfig` 都放进 `/var/lib/knowbase`——如果不显式指定 HOME，`sudo -u knowbase`
或 systemd `User=knowbase` 拿到的 `$HOME` 会是系统默认值（多数发行版是
`/home/knowbase`，且目录并不存在），git/ssh 会去错误的位置找配置，实际却完全找不到
你放好的那些文件：

```bash
sudo useradd -r -d /var/lib/knowbase -m -s /bin/false knowbase
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

凭证使用环境变量或受限环境文件，避免在命令行与进程列表中暴露 secret。

| 变量 | 是否必需 | 说明 |
|------|---------|------|
| `KNOWBASE_LARK_APP_ID` | 是 | 飞书应用 App ID |
| `KNOWBASE_LARK_APP_SECRET` | 是 | 飞书应用 App Secret |
| `KNOWBASE_LARK_SPACE` | 是 | 知识库 space URL（如 `https://org.feishu.cn/wiki/space/123`） |
| `KNOWBASE_MIRROR_REPO_URL` | 仅初次 | Git 仓库 URL，首次 clone 时必需；之后可省略 |
| `KNOWBASE_EXPORTER_EXTRA_ARGS` | 否 | 传递给 `knowbase exporter` 的额外参数（如 `--interval 300` 覆盖默认同步间隔） |
| `KNOWBASE_LARK_ENDPOINT` | 否 | 飞书 API 端点，不指定时默认使用国内 |
| `KNOWBASE_EXPORTER_HEALTH_FILE` | 否 | exporter 状态文件和 Docker 探针共用的路径 |
| `KNOWBASE_EXPORTER_HEALTH_MAX_AGE_SECONDS` | 否 | 探针允许的最后成功推送年龄，默认 600 秒 |
| `KNOWBASE_EXPORTER_CLONE_TIMEOUT_SECONDS` | 否 | Docker 初次 clone 超时，正整数秒，默认 120 |

---

## 相关文档

- 主 README.md — knowbase 全功能文档与快速开始
- [飞书开放平台](https://open.feishu.cn/) — 应用创建与权限申请
- 产品设计文档 — 镜像模式、exporter 架构深度阅读
