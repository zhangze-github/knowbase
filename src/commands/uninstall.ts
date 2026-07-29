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

  try {
    getAutostart().uninstall();
    console.log("• 已注销开机自启并停止守护进程");
  } catch (e) {
    console.warn(`⚠ 注销自启时出错：${e instanceof Error ? e.message : String(e)}`);
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
