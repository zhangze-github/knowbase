import fs from "node:fs";
import { loadConfig, pauseMarkerPath, Logger } from "../config.js";

/** `knowbase pause`：种入暂停标记，定时器将跳过同步周期。 */
export function cmdPause(): number {
  const cfg = loadConfig();
  const marker = pauseMarkerPath(cfg.dir);
  fs.writeFileSync(marker, `paused at ${new Date().toISOString()}\n`);
  new Logger().log("已暂停自动同步（pause）");
  console.log("⏸  已暂停自动同步。");
  console.log(`   标记文件：${marker}`);
  console.log("   大范围改动完成后运行 `knowbase resume` 恢复。");
  return 0;
}
