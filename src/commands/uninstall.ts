import {
  configExists,
  loadConfig,
  clearDaemonState,
  Logger,
} from "../config.js";
import { getAutostart } from "../platform/index.js";

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
  new Logger().log("uninstall：已注销自启并停止守护进程");

  console.log("• 已清理守护进程状态");
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
