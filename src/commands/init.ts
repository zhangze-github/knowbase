import fs from "node:fs";
import path from "node:path";
import {
  Config,
  configExists,
  DEFAULT_BRANCH,
  DEFAULT_INTERVAL,
  defaultDir,
  loadConfig,
  saveConfig,
  Logger,
} from "../config.js";
import * as git from "../git.js";
import { isMirrorMode, setMirrorLock } from "../mirror.js";
import { getAutostart } from "../platform/index.js";
import { syncAgentConfig } from "../agent-config.js";
import { hermesHomeDir } from "../agent-installations.js";
import { syncSkills, summarizeByTool } from "../skills-sync.js";
import {
  configureLarkWriteApp,
  hasLarkCli,
  isValidAppId,
  LARK_WRITE_PROFILE,
  removeLarkWriteProfile,
} from "../lark-write-app.js";

export interface InitOptions {
  dir?: string;
  branch?: string;
  interval?: string;
  /** commander 的 --no-agent-config 会把该值设为 false（默认 true）。 */
  agentConfig?: boolean;
  /** commander 的 --no-skills 会把该值设为 false（默认 true）。 */
  skills?: boolean;
  /** 知识库写入使用的飞书应用；缺省读 KNOWBASE_LARK_APP_ID / KNOWBASE_LARK_APP_SECRET。 */
  appId?: string;
  appSecret?: string;
}

/** 上次 init 配置的写入应用。重跑 init 不带凭证时沿用，不能静默退回个人身份。 */
function previousLarkAppId(): string | undefined {
  if (!configExists()) return undefined;
  try {
    return loadConfig().larkAppId;
  } catch {
    return undefined;
  }
}

function printSshGuidance(url: string): void {
  console.error("");
  console.error("✗ 无法免交互访问远端仓库（凭证可能未配置）。");
  console.error(`  远端：${url}`);
  console.error("");
  console.error("  请先配置好访问凭证，再重新运行 init：");
  if (url.startsWith("http")) {
    console.error("  • HTTPS：确保已配置 git 凭证助手 / Personal Access Token");
    console.error("    例如：git config --global credential.helper store");
  } else {
    console.error("  • SSH：确保已生成并向代码托管平台添加 SSH key");
    console.error("    生成：ssh-keygen -t ed25519 -C \"you@example.com\"");
    console.error("    然后把 ~/.ssh/id_ed25519.pub 添加到 GitHub/GitLab 的 SSH Keys");
    console.error("    验证：ssh -T git@<host>");
  }
  console.error("");
}

/** 确保文件中含某一行（不存在则追加）。返回是否发生改动。 */
function ensureLine(filePath: string, line: string): boolean {
  let content = "";
  if (fs.existsSync(filePath)) content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").map((l) => l.trim());
  if (lines.includes(line.trim())) return false;
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(filePath, prefix + line + "\n");
  return true;
}

export function cmdInit(url: string, opts: InitOptions): number {
  const logger = new Logger();

  // 写入应用的参数在动任何东西之前校验：用户明确要求应用身份时，
  // 不能带着缺失的凭证或工具接入完，再让 agent 退回个人身份写知识库。
  const appId = opts.appId ?? process.env.KNOWBASE_LARK_APP_ID;
  const appSecret = opts.appSecret ?? process.env.KNOWBASE_LARK_APP_SECRET;
  if (Boolean(appId) !== Boolean(appSecret)) {
    console.error("✗ 飞书应用凭证不完整：--app-id 与 --app-secret 必须同时提供。");
    return 1;
  }
  if (appId && !isValidAppId(appId)) {
    console.error(`✗ --app-id 格式不正确：${appId}`);
    return 1;
  }
  if (appId && !hasLarkCli()) {
    console.error("✗ 未检测到 lark-cli，无法配置飞书写入应用。请先安装：");
    console.error("  npx @larksuite/cli@latest install");
    return 1;
  }

  // 1. 环境检查
  const ver = git.gitVersion();
  if (!ver) {
    console.error("✗ 未检测到 git，请先安装 git（建议 ≥ 2.30）。");
    return 1;
  }
  console.log(`• git 版本：${ver}`);
  const cmp = ver.split(".").map((n) => parseInt(n, 10));
  if (cmp[0] < 2 || (cmp[0] === 2 && cmp[1] < 30)) {
    console.warn(`⚠ git 版本偏低（${ver}），建议升级到 ≥ 2.30。`);
  }

  console.log(`• 检查远端可达性：${url} ...`);
  const ls = git.lsRemote(url);
  if (!git.ok(ls)) {
    printSshGuidance(url);
    logger.log(`init 环境检查失败：ls-remote ${url} -> ${ls.stderr.trim()}`);
    return 1;
  }
  console.log("  ✓ 远端可免交互访问");

  const dir = path.resolve(opts.dir ?? defaultDir());
  const branch = opts.branch ?? DEFAULT_BRANCH;
  let interval = DEFAULT_INTERVAL;
  if (opts.interval !== undefined) {
    interval = parseInt(opts.interval, 10);
    if (!Number.isInteger(interval) || interval < 5) {
      console.error(`✗ --interval 必须是 ≥ 5 的整数秒，收到：${opts.interval}`);
      return 1;
    }
  }

  // 2. clone（或复用已存在的同仓库目录）
  if (fs.existsSync(dir)) {
    if (git.isRepo(dir) && git.remoteUrl(dir, "origin") === url) {
      console.log(`• 目录已是该仓库的 clone，复用：${dir}`);
    } else if (fs.readdirSync(dir).length === 0) {
      const c = git.clone(url, dir);
      if (!git.ok(c)) {
        console.error(`✗ clone 失败：${c.stderr.trim()}`);
        return 1;
      }
      console.log(`• 已 clone 到 ${dir}`);
    } else {
      console.error(`✗ 目标目录已存在且非本仓库，请换一个 --dir：${dir}`);
      return 1;
    }
  } else {
    console.log(`• clone 仓库到 ${dir} ...`);
    const c = git.clone(url, dir);
    if (!git.ok(c)) {
      console.error(`✗ clone 失败：${c.stderr.trim()}`);
      return 1;
    }
    console.log("  ✓ clone 完成");
  }

  // 1.0.0 起 knowbase 只服务飞书镜像仓库：本地全程只读，同步严格单向下行。
  // 非镜像仓库在这里硬失败而不是降级接入——接入后守护进程每轮都会拒绝同步
  // （见 syncOnce 的守卫），与其让人装完才发现不能用，不如当场说清楚。
  if (!isMirrorMode(dir)) {
    console.error("");
    console.error("✗ 该仓库不是飞书镜像（仓库根缺少 .knowbase-mirror.json），无法接入。");
    console.error("  1.0.0 起只支持飞书镜像模式：知识的唯一真相源是飞书，本地是只读镜像。");
    console.error("  用 `knowbase exporter` 从飞书知识空间导出镜像仓库，再用它接入；");
    console.error("  仍需要经典双向同步的，请留在 0.9.x。");
    return 1;
  }
  // 首次上锁，收窄「clone 完成到 daemon 首个周期上锁」之间的无锁窗口。
  setMirrorLock(dir, true);
  console.log("");
  console.log("• 本目录是飞书知识库的只读镜像（真相源在飞书）：");
  console.log("  修改请走各文件头部 frontmatter 的 feishu_url，用飞书文档工具编辑对应文档。");
  if (!appId) {
    console.log("  agent 写入依赖本机已配置的 lark 工具链（lark-doc / lark-wiki）；");
    console.log("  未配置则 agent 只读，写入建议由人工在飞书完成（详见 spec §6）。");
  }
  console.log("");

  // 切到目标分支。空仓库（HEAD 未诞生）跳过——首次推送时由 HEAD:<branch> 建立；
  // 非空仓库切换失败则硬失败：沿用错误分支会把其他分支内容推成 <branch>，语义混乱。
  const headBorn = git.ok(git.git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: dir }));
  if (headBorn && git.currentBranch(dir) !== branch) {
    const co = git.git(["checkout", branch], { cwd: dir });
    if (!git.ok(co)) {
      console.error(`✗ 无法切换到分支 ${branch}：${co.stderr.trim()}`);
      console.error(`  远端若使用其他分支名，请用 --branch 指定（当前本地分支：${git.currentBranch(dir)}）。`);
      return 1;
    }
  }

  // 配置写入应用。放在镜像校验之后：被拒绝的仓库不该在本机留下凭证。
  const prevLarkAppId = previousLarkAppId();
  if (appId && appSecret) {
    const r = configureLarkWriteApp(appId, appSecret);
    if (!r.ok) {
      // 校验失败时 lark-cli 也已落盘。首次配置就清掉，别留一份无效凭证；
      // 已接入的机器 config 还指向该 profile，留给用户修正后重跑。
      if (!prevLarkAppId) removeLarkWriteProfile();
      console.error("✗ 飞书写入应用配置失败，请检查 App ID / App Secret 及应用是否已发布：");
      console.error(r.error);
      logger.log(`init 配置写入应用失败：appId=${appId}`);
      return 1;
    }
    console.log(`• 知识库写入将使用飞书应用 ${appId}（lark-cli profile：${LARK_WRITE_PROFILE}）`);
    console.log("  请确认该应用已开通文档编辑权限，且已被加为知识库的可编辑成员。");
  }
  const larkAppId = appId || prevLarkAppId;

  // 4. 保存配置
  const cfg: Config = {
    repoUrl: url,
    dir,
    interval,
    branch,
    agentConfig: opts.agentConfig !== false,
    skills: opts.skills !== false,
    hermesHome: hermesHomeDir(),
    larkAppId,
  };
  saveConfig(cfg);
  console.log("• 已保存配置");

  // 5. 注册开机自启并立即启动
  if (process.env.KNOWBASE_SKIP_AUTOSTART === "1") {
    console.log("• 已跳过自启注册（KNOWBASE_SKIP_AUTOSTART=1）");
  } else try {
    const autostart = getAutostart();
    autostart.install();
    console.log(`• 已注册开机自启并启动守护进程（${autostart.mechanism}）`);
  } catch (e) {
    console.warn(`⚠ 自启注册失败：${e instanceof Error ? e.message : String(e)}`);
    console.warn("  可稍后重跑 init，或手动运行 `knowbase daemon`。");
  }

  // 6. 自动配置 AI agent 全局提示词（默认开启，--no-agent-config 可跳过）
  if (opts.agentConfig === false) {
    console.log("• 已跳过 AI agent 全局提示词配置（--no-agent-config）");
  } else {
    try {
      const changes = syncAgentConfig(dir, undefined, {
        hermesHome: cfg.hermesHome,
        larkWriteApp: Boolean(larkAppId),
      });
      for (const c of changes) {
        if (c.action === "skipped") {
          if (c.reason) {
            console.warn(`⚠ ${c.name} 知识库上下文未更新：${c.reason}`);
            continue;
          }
          console.warn(
            `⚠ ${c.name} 全局提示词未更新：${c.file} 里的 knowbase 区块不完整` +
              `（有 KNOWBASE:START 但缺 KNOWBASE:END）。`
          );
          console.warn(
            "  为避免删掉标记之后的内容已跳过；请手动检查该文件、删除残留的 KNOWBASE:START 后重跑 init。"
          );
          continue;
        }
        const verb =
          c.action === "created"
            ? "已创建并写入"
            : c.action === "updated"
              ? "已更新"
              : "已是最新";
        console.log(`• ${c.name} 全局提示词${verb}：${c.file}`);
      }
    } catch (e) {
      console.warn(
        `⚠ 配置 AI agent 全局提示词时出错：${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // 7. 分发团队 skills（默认开启，--no-skills 可跳过）
  if (opts.skills === false) {
    console.log("• 已跳过团队 skills 分发（--no-skills）");
  } else {
    try {
      const changes = syncSkills(dir, undefined, cfg.hermesHome);
      const done = changes.filter(
        (c) => c.action === "created" || c.action === "updated"
      );
      if (done.length > 0) {
        console.log(`• 已分发团队 skills：${summarizeByTool(done, (c) => c.target)}`);
      } else if (changes.length === 0) {
        console.log("• 知识库暂无 skills/ 目录，跳过团队 skills 分发");
      }
      // removed 也要打印：静默删掉一个副本是「知识库里已经没有这个 skill 了」
      // 的唯一可见信号，不打印用户只会发现 skill 莫名消失（agent-config 那边连
      // unchanged 都会打印「已是最新」，这里更不该沉默）。
      const gone = changes.filter((c) => c.action === "removed");
      if (gone.length > 0) {
        console.log(`• 已撤下知识库中已删除的团队 skills：${summarizeByTool(gone, (c) => c.target)}`);
      }
      for (const c of changes) {
        if (c.action === "foreign" || c.action === "invalid" || c.action === "failed") {
          // 与 sync-engine.ts 的 refreshOrgSkills 同一格式：不带 tool 标注时，
          // 两个目标各出一条 foreign/failed 会打印成两行完全相同的文字，
          // 读起来像重复打印的 bug，而不是「两个目标各有一次」。
          const where = c.tool ? `，${c.tool}` : "";
          console.warn(`⚠ skill ${c.name} 未分发（${c.action}${where}）：${c.reason}`);
        }
      }
    } catch (e) {
      console.warn(
        `⚠ 分发团队 skills 时出错：${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  console.log("\n✓ 接入完成。支持 Claude Code / Codex / Cursor（桌面版与 CLI）/ Hermes；具体配置结果见上方。");
  console.log("  运行 `knowbase status` 查看健康度。");
  logger.log(`init 完成：dir=${dir} url=${url} branch=${branch}`);
  return 0;
}
