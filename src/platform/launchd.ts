import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { logPath } from "../config.js";
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
    const log = logPath();
    const args = [node, script, "daemon"];
    const progArgs = args
      .map((a) => `    <string>${xmlEscape(a)}</string>`)
      .join("\n");
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
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
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
