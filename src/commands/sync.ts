import { loadConfig, Logger } from "../config.js";
import { syncOnce } from "../sync-engine.js";

/**
 * `knowbase sync`：前台立即从飞书镜像拉取一次，输出过程。
 *
 * **刻意不做**的两件事：不刷新 agent 提示词、不分发团队 skills（设计文档 §9.2）。
 * `sync` 是拉取与排查用的命令，顺手改用户的 `~/.claude/` 是意外副作用；
 * 守护进程在一个周期内也会补上。别顺手在这里加 refreshAgentPrompts /
 * refreshOrgSkills——那不是补漏，是扩大这条命令的作用范围。
 */
export function cmdSync(): number {
  const cfg = loadConfig();
  const logger = new Logger();
  console.log(`同步中：${cfg.repoUrl} (${cfg.branch}) → ${cfg.dir}`);

  const r = syncOnce(cfg, { logger });

  if (r.notMirror) {
    console.error(`✗ ${r.error}`);
    return 1;
  }
  if (r.merged) console.log("• 已跟随飞书镜像的最新内容");
  if (r.discardedFiles.length > 0) {
    console.log(
      `• 镜像只读，已丢弃本地改动 ${r.discardedFiles.length} 个文件：${r.discardedFiles.join(", ")}`
    );
    console.log("  修改请走各文件 frontmatter 的 feishu_url");
  }

  if (r.error) {
    console.error(`✗ ${r.error}`);
    console.error(`  详见日志：${logger.path()}`);
    return 1;
  }
  if (!r.merged) console.log("• 已是最新，无需同步");
  console.log("✓ 完成");
  return 0;
}
