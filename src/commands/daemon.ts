import { configExists, loadConfig, Logger } from "../config.js";
import { runDaemon } from "../sync-engine.js";
import { getAutostart } from "../platform/index.js";

/** `knowbase daemon`（隐藏命令）：被服务管理器拉起的守护进程本体。 */
export async function cmdDaemon(): Promise<void> {
  const cfg = loadConfig();
  const logger = new Logger();
  await runDaemon(cfg, { logger });
}

/**
 * `knowbase daemon-restart`（隐藏命令）：npm 全局升级后由 postinstall 调用。
 *
 * `npm i -g knowbase` 只替换磁盘上的文件，常驻守护进程仍跑着内存里的旧代码。
 * 新版本的守护进程会自己检测升级并重启（见 runDaemon），但从**不带这个检测的
 * 旧版本**升级上来时只能靠这里：在安装时重启一次服务，让成员升级后不用重跑
 * init、不用重启电脑就生效。
 *
 * 从不失败：没接入、没注册自启、重启出错都只打印一行，绝不让 npm 安装失败。
 */
export function cmdDaemonRestart(): void {
  try {
    if (!configExists()) return;
    const autostart = getAutostart();
    if (!autostart.isInstalled()) return;
    autostart.restart();
    console.log("knowbase：已重启后台守护进程，新版本已生效");
  } catch (e) {
    console.log(
      `knowbase：未能自动重启后台守护进程（${e instanceof Error ? e.message : String(e)}），` +
        "请运行 knowbase init <原 git 地址> 或重新登录后生效"
    );
  }
}
