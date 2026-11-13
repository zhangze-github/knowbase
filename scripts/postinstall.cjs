// npm 全局升级后重启 knowbase 守护进程，让它加载新版本（见 src/commands/daemon.ts 的 cmdDaemonRestart）。
// 只在全局安装时生效；任何情况下都以 0 退出，绝不让安装失败。
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

try {
  const cli = path.join(__dirname, "..", "dist", "cli.js");
  if (
    process.env.npm_config_global === "true" &&
    process.env.KNOWBASE_SKIP_AUTOSTART !== "1" &&
    fs.existsSync(cli)
  ) {
    spawnSync(process.execPath, [cli, "daemon-restart"], { stdio: "inherit", timeout: 30000 });
  }
} catch {
  // ignore
}
process.exit(0);
