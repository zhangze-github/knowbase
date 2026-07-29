import fs from "node:fs";
import path from "node:path";

/**
 * 上行加速的两个积木：防抖器 + 文件监听。
 * 设计：监听只负责「本地有动静」这一个信号；何时真正同步由防抖器决定，
 * 同步动作本身仍完全走 sync-engine 的 syncOnce（含暂停检查）。
 */

export interface Debouncer {
  /** 收到一次事件：重置静默计时；首次事件同时启动最大等待计时。 */
  touch(): void;
  /** 取消所有待触发（同步刚做完时调用，避免多余的一次触发）。 */
  cancel(): void;
  /** 是否有待触发的计时器（测试用）。 */
  pending(): boolean;
}

export interface DebouncerOptions {
  /** 静默期：最后一次事件后等这么久才触发。 */
  quietMs: number;
  /** 最大等待：连续编辑不断重置静默时，从首个事件起最迟这么久必触发（防饿死）。 */
  maxWaitMs: number;
  onFire: () => void;
}

export function createDebouncer(opts: DebouncerOptions): Debouncer {
  let quiet: NodeJS.Timeout | null = null;
  let max: NodeJS.Timeout | null = null;

  const clearAll = () => {
    if (quiet) {
      clearTimeout(quiet);
      quiet = null;
    }
    if (max) {
      clearTimeout(max);
      max = null;
    }
  };

  const fire = () => {
    clearAll();
    opts.onFire();
  };

  return {
    touch() {
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(fire, opts.quietMs);
      if (!max) max = setTimeout(fire, opts.maxWaitMs);
    },
    cancel: clearAll,
    pending: () => quiet !== null || max !== null,
  };
}

/**
 * 递归监听知识库目录。过滤掉与用户内容无关的事件：
 * - .git/ 内部（fetch/merge/gc 都会大量触发）
 * - .knowbase-pause 标记本身（pause/resume 不该算「内容改动」）
 *
 * 返回 null 表示该平台不支持递归监听（Linux + Node < 20），
 * 调用方应退化为纯轮询。
 */
export function startWatcher(
  dir: string,
  onEvent: () => void,
  onError?: (e: Error) => void
): fs.FSWatcher | null {
  try {
    const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (filename) {
        const norm = String(filename).split(path.sep).join("/");
        if (norm === ".git" || norm.startsWith(".git/")) return;
        if (norm === ".knowbase-pause") return;
      }
      // filename 为 null（部分平台不提供）时保守触发
      onEvent();
    });
    watcher.on("error", (e) => {
      try {
        watcher.close();
      } catch {
        // ignore
      }
      onError?.(e instanceof Error ? e : new Error(String(e)));
    });
    return watcher;
  } catch {
    return null;
  }
}
