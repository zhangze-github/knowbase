#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import updateNotifier from "update-notifier";
import { cmdInit, InitOptions } from "./commands/init.js";
import { cmdStatus } from "./commands/status.js";
import { cmdSync } from "./commands/sync.js";
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
    "以飞书知识库为唯一真相源的团队知识镜像：安装即忘，后台自动把飞书内容同步成本地只读 Markdown，人和 AI 都能直接 grep。"
  )
  .version(pkg.version, "-v, --version", "输出版本号");

program
  .command("init")
  .argument("<git-url>", "飞书镜像仓库的 Git 地址（由 knowbase exporter 导出，仓库根须有 .knowbase-mirror.json）")
  .option("--dir <path>", "本地知识库目录（默认 ~/org-kb）")
  .option("--branch <branch>", "同步分支（默认 main）")
  .option("--interval <seconds>", "同步间隔秒数（默认 60）")
  .option("--no-agent-config", "跳过配置 Claude Code / Codex / Cursor / Hermes 知识库上下文")
  .option("--no-skills", "跳过把知识库 skills/ 分发到所有分发目标（Claude Code / Codex / Cursor / Hermes）")
  .description("一次性接入：环境检查 → clone → 上只读锁 → 注册自启 → 配置 AI agent 全局提示词")
  .action((url: string, opts: InitOptions) => run(() => cmdInit(url, opts)));

program
  .command("status")
  .description("一屏查看健康度：守护进程 / 上次同步 / 本地改动丢弃 / 远端连通性")
  .action(() => run(cmdStatus));

program
  .command("sync")
  .description("立即从飞书镜像拉取一次（前台输出过程，不必等轮询）")
  .action(() => run(cmdSync));

program
  .command("uninstall")
  .description("干净移除：注销自启、停止守护进程、删除配置与 agent 提示词区块，保留本地文件夹")
  .action(() => run(cmdUninstall));

program
  .command("exporter")
  .requiredOption("--repo <path>", "已 clone 的飞书镜像仓库本地路径")
  .requiredOption("--space <spaceOrUrl>", "飞书 wiki 链接（空间首页或节点）或 space_id")
  .option("--host <host>", "飞书域名，如 acme.feishu.cn（--space 为纯 space_id 时必填）")
  .option("--root <nodeToken>", "只导出该节点为根的子树（覆盖 --space 节点链接中解析出的 token）")
  .option("--branch <branch>", "推送分支（默认 main）")
  .option("--interval <seconds>", "守护循环轮询间隔秒数（默认 120）")
  .option("--inbox-url <url>", "（已废弃，保留兼容）写入 manifest 的 agent_inbox_url；成员侧提示词已不再使用专属沉淀目录")
  .option("--once", "只跑一轮导出后退出（退出码：失败为 1，成功为 0），用于 cron 部署或冒烟验证")
  .option("--full", "本轮强制全量对账，忽略 24h 窗口（仅可与 --once 连用；daemon 模式已按 24h 自动全量对账）")
  .option("--app-id <id>", "飞书自建应用 App ID（缺省读环境变量 KNOWBASE_LARK_APP_ID）")
  .option(
    "--app-secret <secret>",
    "飞书自建应用 App Secret（缺省读环境变量 KNOWBASE_LARK_APP_SECRET；命令行传参会留在 shell history，长驻部署推荐用环境变量）"
  )
  .option("--endpoint <url>", "飞书开放平台 API 端点（缺省读 KNOWBASE_LARK_ENDPOINT，默认 https://open.feishu.cn）")
  .description(
    "把飞书知识空间导出为本地 Markdown 镜像仓库并持续同步（全部参数可经命令行传入；凭证也可走环境变量 KNOWBASE_LARK_APP_ID / KNOWBASE_LARK_APP_SECRET）"
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
