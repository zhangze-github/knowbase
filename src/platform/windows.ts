import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configDir, pidAlive, readDaemonState } from "../config.js";
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

  restart(): void {
    // 计划任务启动的是 VBS 启动器，它拉起 node 后立即退出；/End 管不到真正的
    // 守护进程，只能按状态文件里的 pid 结束它，再让任务重新拉起新版本。
    const pid = readDaemonState()?.pid;
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid);
      } catch {
        // 已退出
      }
      // 等旧进程真正退出：新实例启动时若旧 pid 仍存活，会被单实例保护直接退出
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      for (let i = 0; i < 50 && pidAlive(pid); i++) Atomics.wait(sleeper, 0, 0, 100);
    }
    // 重写启动器：node / 脚本路径可能随升级变化
    this.writeLauncher();
    const r = schtasks("/Run", "/TN", TASK);
    if (r.code !== 0) throw new Error(`schtasks /Run 失败：${r.out.trim()}`);
  }

  isInstalled(): boolean {
    const r = schtasks("/Query", "/TN", TASK);
    return r.code === 0;
  }
}
