import fs from "node:fs";
import path from "node:path";
import {
  Config,
  DEFAULT_BRANCH,
  DEFAULT_INTERVAL,
  PAUSE_MARKER,
  defaultDir,
  saveConfig,
  Logger,
} from "../config.js";
import * as git from "../git.js";
import { getAutostart } from "../platform/index.js";
import { syncAgentConfig } from "../agent-config.js";

export interface InitOptions {
  dir?: string;
  branch?: string;
  interval?: string;
  /** commander 的 --no-agent-config 会把该值设为 false（默认 true）。 */
  agentConfig?: boolean;
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

  // git 身份提示（缺失时同步引擎会用临时身份兜底，不阻塞）
  if (!git.hasIdentity(dir)) {
    console.warn("⚠ 未配置 git user.name/email，自动提交将使用临时身份 knowbase[主机名]。");
    console.warn('  建议配置：git config --global user.name "你的名字" && git config --global user.email "you@example.com"');
  }

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

  // 3. 种入 union 合并规则与忽略规则（无则提交推送）
  let seeded = false;
  seeded = ensureLine(path.join(dir, ".gitattributes"), "*.md merge=union") || seeded;
  seeded = ensureLine(path.join(dir, ".gitignore"), PAUSE_MARKER) || seeded;
  if (seeded) {
    console.log("• 种入 .gitattributes(union) / .gitignore 规则");
    git.addAll(dir);
    const c = git.commit(dir, "chore(knowbase): 种入 union 合并规则与忽略规则");
    if (git.ok(c)) {
      const p = git.push(dir, "origin", branch);
      if (!p.ok) {
        console.warn("⚠ 规则已本地提交，但推送未成功（守护进程会自动重试）。");
      }
    } else {
      console.warn(
        `⚠ 规则文件已写入但提交失败（可能未配置 git user.name/email）：${(c.stderr || c.stdout).trim()}`
      );
    }
  } else {
    console.log("• 仓库已含 union / 忽略规则");
  }

  // 4. 保存配置
  const cfg: Config = {
    repoUrl: url,
    dir,
    interval,
    branch,
    agentConfig: opts.agentConfig !== false,
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
      const changes = syncAgentConfig(dir);
      for (const c of changes) {
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

  console.log("\n✓ 接入完成。你的 Claude Code / Codex 已知道知识库位置。");
  console.log("  运行 `knowbase status` 查看健康度。");
  logger.log(`init 完成：dir=${dir} url=${url} branch=${branch}`);
  return 0;
}
