#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import updateNotifier from "update-notifier";
import { cmdInit, InitOptions } from "./commands/init.js";
import { cmdStatus } from "./commands/status.js";
import { cmdSync } from "./commands/sync.js";
import { cmdPause } from "./commands/pause.js";
import { cmdResume } from "./commands/resume.js";
import { cmdUninstall } from "./commands/uninstall.js";
import { cmdDaemon } from "./commands/daemon.js";
import { cmdExporter } from "./commands/exporter.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

/** 运行一个同步命令并按返回码退出；统一捕获异常。 */
function run(fn: () => number): void {
  try {
    process.exit(fn());
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

const program = new Command();

program
  .name("knowbase")
  .description(
    "AI 时代的团队知识库同步工具：安装即忘，本地文件夹 ⇋ Git 远端后台自动双向同步，冲突全自动处理。"
  )
  .version(pkg.version, "-v, --version", "输出版本号");

program
  .command("init")
  .argument("<git-url>", "知识库 Git 远端地址（GitHub/GitLab 私有仓库）")
  .option("--dir <path>", "本地知识库目录（默认 ~/org-kb）")
  .option("--branch <branch>", "同步分支（默认 main）")
  .option("--interval <seconds>", "同步间隔秒数（默认 60）")
  .option("--no-agent-config", "跳过写入 Claude Code / Codex 全局提示词")
  .option("--no-skills", "跳过把知识库 skills/ 分发到所有分发目标（Claude Code / Codex）")
  .description("一次性接入：环境检查 → clone → 种入规则 → 注册自启 → 配置 AI agent 全局提示词")
  .action((url: string, opts: InitOptions) => run(() => cmdInit(url, opts)));

program
  .command("status")
  .description("一屏查看健康度：守护进程 / 上次同步 / 未推送改动 / 冲突副本 / 远端连通性")
  .action(() => run(cmdStatus));

program
  .command("sync")
  .description("立即触发一次同步周期（前台输出过程，用于排查和急用）")
  .action(() => run(cmdSync));

program
  .command("pause")
  .description("暂停自动同步（大范围改动期间用，避免半成品被提交）")
  .action(() => run(cmdPause));

program
  .command("resume")
  .description("恢复自动同步")
  .action(() => run(cmdResume));

program
  .command("uninstall")
  .description("干净移除：注销自启、停止守护进程，保留本地文件夹")
  .action(() => run(cmdUninstall));

program
  .command("exporter")
  .requiredOption("--repo <path>", "已 clone 的飞书镜像仓库本地路径")
  .requiredOption("--space <spaceOrUrl>", "飞书 wiki 链接（空间首页或节点）或 space_id")
  .option("--host <host>", "飞书域名，如 acme.feishu.cn（--space 为纯 space_id 时必填）")
  .option("--root <nodeToken>", "只导出该节点为根的子树（覆盖 --space 节点链接中解析出的 token）")
  .option("--branch <branch>", "推送分支（默认 main）")
  .option("--interval <seconds>", "守护循环轮询间隔秒数（默认 120）")
  .option("--inbox-url <url>", "写回收件箱链接（写入 manifest，供后续写回能力使用）")
  .option("--once", "只跑一轮导出后退出（退出码：失败为 1，成功为 0），用于 cron 部署或冒烟验证")
  .option("--full", "本轮强制全量对账，忽略 24h 窗口")
  .description(
    "把飞书知识空间导出为本地 Markdown 镜像仓库并持续同步（凭证走环境变量 KNOWBASE_LARK_APP_ID / KNOWBASE_LARK_APP_SECRET，不走命令行参数）"
  )
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    try {
      process.exitCode = await cmdExporter(opts);
    } catch (e) {
      console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  });

// 隐藏命令：守护进程本体，由服务管理器拉起
program
  .command("daemon", { hidden: true })
  .description("（内部）后台守护进程本体")
  .action(async () => {
    try {
      await cmdDaemon();
    } catch (e) {
      console.error(`daemon 退出：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

// 升级提示：后台检查、每 24h 至多一次，绝不拖慢命令（product.md §2.2 / §5.3）
// daemon 自身不做提示。
if (process.argv[2] !== "daemon") {
  updateNotifier({ pkg, updateCheckInterval: 1000 * 60 * 60 * 24 }).notify({
    message: `有新版本 knowbase：{currentVersion} → {latestVersion}\n运行 npm i -g ${pkg.name} 升级`,
  });
}

program.parseAsync(process.argv);
