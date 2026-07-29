import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { daemonStdoutPath } from "../config.js";
import { Autostart, selfInvocation } from "./index.js";

const LABEL = "com.knowbase.daemon";

function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function domainTarget(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

function launchctl(...args: string[]): { code: number; out: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export class LaunchdAutostart implements Autostart {
  readonly mechanism = "launchd LaunchAgent";

  definitionPath(): string {
    return plistPath();
  }

  private buildPlist(): string {
    const { node, script } = selfInvocation();
    // 与 Logger 的轮转日志分开：Logger rename 后 launchd 的旧 fd 会写错文件
    const stdout = daemonStdoutPath();
    const args = [node, script, "daemon"];
    const progArgs = args
      .map((a) => `    <string>${xmlEscape(a)}</string>`)
      .join("\n");
    // launchd 不继承 shell 环境；用户自定义 XDG_CONFIG_HOME 时需固化进服务定义，
    // 否则守护进程按默认 ~/.config 找不到配置。
    const xdg = process.env.XDG_CONFIG_HOME?.trim();
    const envBlock = xdg
      ? `  <key>EnvironmentVariables</key>
  <dict>
    <key>XDG_CONFIG_HOME</key>
    <string>${xmlEscape(xdg)}</string>
  </dict>
`
      : "";
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${progArgs}
  </array>
${envBlock}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stdout)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
  }

  install(): void {
    const p = plistPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, this.buildPlist(), "utf8");

    // 先尝试卸载旧实例（幂等），忽略失败
    launchctl("bootout", `${domainTarget()}/${LABEL}`);

    // 现代方式：bootstrap；失败则回退到 legacy load -w
    const boot = launchctl("bootstrap", domainTarget(), p);
    if (boot.code !== 0) {
      const load = launchctl("load", "-w", p);
      if (load.code !== 0) {
        throw new Error(
          `launchctl 加载失败：${boot.out.trim()} / ${load.out.trim()}`
        );
      }
    }
    // 立即启动一次（bootstrap+RunAtLoad 通常已启动，kickstart 保险）
    launchctl("kickstart", "-k", `${domainTarget()}/${LABEL}`);
  }

  uninstall(): void {
    const p = plistPath();
    launchctl("bootout", `${domainTarget()}/${LABEL}`);
    launchctl("unload", "-w", p); // legacy 回退，忽略失败
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }

  isInstalled(): boolean {
    if (!fs.existsSync(plistPath())) return false;
    const r = launchctl("print", `${domainTarget()}/${LABEL}`);
    return r.code === 0;
  }
}
