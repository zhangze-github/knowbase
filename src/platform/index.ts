import fs from "node:fs";
import path from "node:path";
import { LaunchdAutostart } from "./launchd.js";
import { SystemdAutostart } from "./systemd.js";
import { WindowsAutostart } from "./windows.js";

/** 统一的自启接口：三平台各自实现，指向 `knowbase daemon`。 */
export interface Autostart {
  /** 人类可读的机制名（launchd / systemd / 计划任务）。 */
  readonly mechanism: string;
  /** 注册开机自启并立即启动。 */
  install(): void;
  /** 停止并注销自启；不存在时应幂等。 */
  uninstall(): void;
  /** 服务管理器视角下是否已注册。 */
  isInstalled(): boolean;
  /** 面向用户的服务定义文件路径（用于 status/排查）。 */
  definitionPath(): string;
}

/**
 * 找一个「跨升级稳定」的 node 路径。
 * process.execPath 会解析符号链接，得到形如
 * /opt/homebrew/Cellar/node/24.7.0/bin/node 的带版本路径——node 一升级该路径
 * 即失效，launchd/systemd 会无声地拉不起守护进程。因此优先使用指向同一
 * 二进制的稳定符号链接（brew/常规安装位置），找不到才退回 execPath。
 */
export function stableNodePath(): string {
  const exec = process.execPath;
  let execReal: string;
  try {
    execReal = fs.realpathSync(exec);
  } catch {
    return exec;
  }
  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ];
  for (const c of candidates) {
    try {
      if (fs.realpathSync(c) === execReal) return c;
    } catch {
      // 候选不存在，继续
    }
  }
  return exec;
}

/** 解析「如何再次调用自己」：node 可执行文件 + cli 入口脚本绝对路径。 */
export function selfInvocation(): { node: string; script: string } {
  // argv[1] 故意不做 realpath：全局安装时它是 /opt/homebrew/bin/knowbase
  // 这类稳定符号链接，npm 升级包后依然有效。
  const script = path.resolve(process.argv[1] ?? "");
  return { node: stableNodePath(), script };
}

export function getAutostart(): Autostart {
  switch (process.platform) {
    case "darwin":
      return new LaunchdAutostart();
    case "linux":
      return new SystemdAutostart();
    case "win32":
      return new WindowsAutostart();
    default:
      throw new Error(`暂不支持的平台：${process.platform}`);
  }
}
