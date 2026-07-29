import fs from "node:fs";
import { loadConfig, pauseMarkerPath, isPaused, Logger } from "../config.js";

/** `knowbase resume`：移除暂停标记，恢复自动同步。 */
export function cmdResume(): number {
  const cfg = loadConfig();
  if (!isPaused(cfg.dir)) {
    console.log("当前未处于暂停状态，无需恢复。");
    return 0;
  }
  fs.rmSync(pauseMarkerPath(cfg.dir), { force: true });
  new Logger().log("已恢复自动同步（resume）");
  console.log("▶  已恢复自动同步。");
  return 0;
}
