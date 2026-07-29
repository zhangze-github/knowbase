import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configDir } from "../config.js";
import { Autostart, selfInvocation } from "./index.js";

const TASK = "knowbase";

function vbsPath(): string {
  return path.join(configDir(), "knowbase-daemon.vbs");
}

function schtasks(...args: string[]): { code: number; out: string } {
  const r = spawnSync("schtasks", args, { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

export class WindowsAutostart implements Autostart {
  readonly mechanism = "计划任务（登录触发）";

  definitionPath(): string {
    return `计划任务 \\${TASK}（启动器：${vbsPath()}）`;
  }

  /**
   * 用 VBS 包一层，以隐藏窗口方式启动 daemon，避免每次登录弹出控制台。
   */
  private writeLauncher(): void {
    const { node, script } = selfInvocation();
    const vbs =
      `Set WshShell = CreateObject("WScript.Shell")\r\n` +
      `WshShell.Run """${node}"" ""${script}"" daemon", 0, False\r\n`;
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(vbsPath(), vbs, "utf8");
  }

  install(): void {
    this.writeLauncher();
    // 先删旧任务（幂等）
    schtasks("/Delete", "/TN", TASK, "/F");
    const tr = `wscript.exe "${vbsPath()}"`;
    const r = schtasks(
      "/Create",
      "/TN",
      TASK,
      "/SC",
      "ONLOGON",
      "/TR",
      tr,
      "/RL",
      "LIMITED",
      "/F"
    );
    if (r.code !== 0) {
      throw new Error(`schtasks 创建失败：${r.out.trim()}`);
    }
    // 立即启动一次
    schtasks("/Run", "/TN", TASK);
  }

  uninstall(): void {
    schtasks("/End", "/TN", TASK);
    schtasks("/Delete", "/TN", TASK, "/F");
    try {
      fs.rmSync(vbsPath(), { force: true });
    } catch {
      // ignore
    }
  }

  isInstalled(): boolean {
    const r = schtasks("/Query", "/TN", TASK);
    return r.code === 0;
  }
}
