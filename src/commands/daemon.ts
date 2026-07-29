import { loadConfig, Logger } from "../config.js";
import { runDaemon } from "../sync-engine.js";

/** `knowbase daemon`（隐藏命令）：被服务管理器拉起的守护进程本体。 */
export async function cmdDaemon(): Promise<void> {
  const cfg = loadConfig();
  const logger = new Logger();
  await runDaemon(cfg, { logger });
}
