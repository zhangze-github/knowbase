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

/** 解析「如何再次调用自己」：node 可执行文件 + cli 入口脚本绝对路径。 */
export function selfInvocation(): { node: string; script: string } {
  const script = path.resolve(process.argv[1] ?? "");
  return { node: process.execPath, script };
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
