import fs from "node:fs";
import {
  configExists,
  configPath,
  loadConfig,
  clearDaemonState,
  daemonStdoutPath,
  Logger,
} from "../config.js";
import { getAutostart } from "../platform/index.js";
import { uninstallAgentConfig } from "../agent-config.js";
import { uninstallSkills } from "../skills-sync.js";

/** `knowbase uninstall`：注销自启、停止守护进程、保留本地文件夹。 */
export function cmdUninstall(): number {
  let dir: string | null = null;
  if (configExists()) {
    try {
      dir = loadConfig().dir;
    } catch {
      dir = null;
    }
  }

  // 与 init 对称的守卫。launchd/systemd 的作业标签是硬编码常量、域名取自 uid，
  // 两者都不随 HOME 变化：测试把 HOME 指向临时目录也拦不住 bootout 打到开发者
  // 本机真实的 com.knowbase.daemon 上，跑一次测试就会把自己的知识库同步拆掉。
  if (process.env.KNOWBASE_SKIP_AUTOSTART === "1") {
    console.log("• 已跳过自启注销（KNOWBASE_SKIP_AUTOSTART=1）");
  } else {
    try {
      getAutostart().uninstall();
      console.log("• 已注销开机自启并停止守护进程");
    } catch (e) {
      console.warn(`⚠ 注销自启时出错：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  clearDaemonState();

  // 移除写入各 AI agent 全局提示词的托管区块
  try {
    const removals = uninstallAgentConfig();
    for (const r of removals) {
      if (r.removed) console.log(`• 已从 ${r.name} 全局提示词移除知识库区块：${r.file}`);
    }
  } catch (e) {
    console.warn(`⚠ 移除 agent 提示词区块时出错：${e instanceof Error ? e.message : String(e)}`);
  }

  // 移除分发到 ~/.claude/skills 的团队 skills 副本（无托管标记的目录一律不碰）
  try {
    const removed = uninstallSkills().filter((r) => r.removed);
    if (removed.length > 0) {
      console.log(
        `• 已从 ~/.claude/skills 移除团队 skills ${removed.length} 个：` +
          removed.map((r) => r.target).join(", ")
      );
    }
  } catch (e) {
    console.warn(
      `⚠ 移除团队 skills 时出错：${e instanceof Error ? e.message : String(e)}`
    );
  }

  new Logger().log("uninstall：已注销自启并停止守护进程");

  // 移除配置与守护进程 stdout（保留 knowbase.log 供事后排查）
  try {
    fs.rmSync(configPath(), { force: true });
    fs.rmSync(daemonStdoutPath(), { force: true });
  } catch {
    // ignore
  }

  console.log("• 已清理守护进程状态与配置（日志保留以便排查）");
  if (dir) {
    console.log("");
    console.log(`✓ 已卸载。本地知识库文件夹已保留，不会删除：`);
    console.log(`  ${dir}`);
    console.log("  如需彻底删除，请自行 rm -rf 该目录。");
  } else {
    console.log("✓ 已卸载。");
  }
  return 0;
}
