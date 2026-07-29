import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { daemonStdoutPath } from "../config.js";
import { Autostart, selfInvocation } from "./index.js";

const UNIT = "knowbase.service";

function unitDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== ""
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");
  return path.join(base, "systemd", "user");
}

function unitPath(): string {
  return path.join(unitDir(), UNIT);
}

function systemctl(...args: string[]): { code: number; out: string } {
  const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

export class SystemdAutostart implements Autostart {
  readonly mechanism = "systemd user service";

  definitionPath(): string {
    return unitPath();
  }

  private buildUnit(): string {
    const { node, script } = selfInvocation();
    // systemd user service 不继承 shell 环境；固化自定义 XDG_CONFIG_HOME
    const xdg = process.env.XDG_CONFIG_HOME?.trim();
    const envLine = xdg ? `Environment=XDG_CONFIG_HOME=${xdg}\n` : "";
    return `[Unit]
Description=knowbase 知识库后台同步守护进程
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${node} ${script} daemon
Restart=always
RestartSec=10
${envLine}StandardOutput=append:${daemonStdoutPath()}
StandardError=append:${daemonStdoutPath()}

[Install]
WantedBy=default.target
`;
  }

  install(): void {
    fs.mkdirSync(unitDir(), { recursive: true });
    fs.writeFileSync(unitPath(), this.buildUnit(), "utf8");

    // 允许用户服务在未登录时也运行（product.md §2.4）
    spawnSync("loginctl", ["enable-linger", os.userInfo().username], {
      encoding: "utf8",
    });

    systemctl("daemon-reload");
    const en = systemctl("enable", "--now", UNIT);
    if (en.code !== 0) {
      throw new Error(`systemctl enable 失败：${en.out.trim()}`);
    }
  }

  uninstall(): void {
    systemctl("disable", "--now", UNIT);
    try {
      fs.rmSync(unitPath(), { force: true });
    } catch {
      // ignore
    }
    systemctl("daemon-reload");
  }

  isInstalled(): boolean {
    if (!fs.existsSync(unitPath())) return false;
    const r = systemctl("is-enabled", UNIT);
    return r.code === 0;
  }
}
