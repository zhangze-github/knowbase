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

export interface InitOptions {
  dir?: string;
  branch?: string;
  interval?: string;
  writeClaudeMd?: boolean;
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

function integrationSnippet(dir: string): string {
  return `## 组织知识库（knowbase）

本机知识库位于：\`${dir}\`
它是一个由 knowbase 后台自动与 Git 远端双向同步的普通文件夹。

- 需要组织的业务背景、历史决策、环境配置等隐性知识时，直接 grep / 读取该目录下的 Markdown。
- 产生了值得沉淀的新知识时，直接在该目录写入/编辑 Markdown 即可，保存即同步，无需 commit/push。
- 进行大范围改动前先运行 \`knowbase pause\`，完成后 \`knowbase resume\`，避免半成品被自动提交。
`;
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
  const interval = opts.interval ? parseInt(opts.interval, 10) : DEFAULT_INTERVAL;

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

  // 切到目标分支（若与当前不同且远端存在该分支）
  if (git.currentBranch(dir) !== branch) {
    const co = git.git(["checkout", branch], { cwd: dir });
    if (!git.ok(co)) {
      console.warn(`⚠ 无法切换到分支 ${branch}，沿用当前分支 ${git.currentBranch(dir)}`);
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
  const cfg: Config = { repoUrl: url, dir, interval, branch };
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

  // 6. 集成片段
  const snippet = integrationSnippet(dir);
  if (opts.writeClaudeMd) {
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      const f = path.join(dir, name);
      fs.appendFileSync(f, (fs.existsSync(f) ? "\n" : "") + snippet);
    }
    console.log("• 已把集成片段追加到知识库目录的 CLAUDE.md / AGENTS.md");
  } else {
    console.log("\n把下面这段粘贴到你的 CLAUDE.md / AGENTS.md：\n");
    console.log("————————————————————————————————");
    console.log(snippet);
    console.log("————————————————————————————————");
    console.log("（或重跑 init 时加 --write-claude-md 直接写入知识库目录）");
  }

  console.log("\n✓ 接入完成。运行 `knowbase status` 查看健康度。");
  logger.log(`init 完成：dir=${dir} url=${url} branch=${branch}`);
  return 0;
}
