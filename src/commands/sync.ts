import { loadConfig, Logger } from "../config.js";
import { syncOnce } from "../sync-engine.js";

/**
 * `knowbase sync`：前台立即跑一次同步周期，输出过程。
 *
 * **刻意不做**的两件事：不刷新 agent 提示词、不分发团队 skills（设计文档 §9.2）。
 * `sync` 是排查 git 同步用的命令，顺手改用户的 `~/.claude/` 是意外副作用；
 * 守护进程在一个周期内也会补上。别顺手在这里加 refreshAgentPrompts /
 * refreshOrgSkills——那不是补漏，是扩大这条命令的作用范围。
 */
export function cmdSync(): number {
  const cfg = loadConfig();
  const logger = new Logger();
  console.log(`同步中：${cfg.dir} ⇋ ${cfg.repoUrl} (${cfg.branch})`);

  const r = syncOnce(cfg, { logger });

  if (r.paused) {
    console.log("⏸  已暂停（存在 .knowbase-pause），本次跳过。运行 `knowbase resume` 恢复。");
    return 0;
  }
  if (r.committed) console.log("• 已提交本地改动");
  if (r.merged) console.log("• 已合并远端改动");
  if (r.conflictCopies.length > 0) {
    console.log(`• 生成冲突副本 ${r.conflictCopies.length} 个：${r.conflictCopies.join(", ")}`);
  }
  if (r.pushed) console.log("• 已推送到远端");
  if (r.pushRejected) console.log("• push 被拒（并发竞争），下一周期会先合并再推");
  if (r.pushDenied)
    console.log(
      "• 没有仓库写权限：本地改动已提交在本机，暂无法同步给团队。请联系仓库管理员开通写权限，之后守护进程会自动恢复推送。"
    );

  if (r.error) {
    console.error(`✗ ${r.error}`);
    console.error(`  详见日志：${logger.path()}`);
    return 1;
  }
  if (!r.committed && !r.merged && !r.pushed) {
    console.log("• 已是最新，无需同步");
  }
  console.log("✓ 完成");
  return 0;
}
