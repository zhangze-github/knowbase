import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createDebouncer, startWatcher } from "../src/watcher.js";
import { tmpDir } from "./helpers.js";

describe("防抖器", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("静默期满触发一次", () => {
    const fire = vi.fn();
    const d = createDebouncer({ quietMs: 3000, maxWaitMs: 30000, onFire: fire });
    d.touch();
    vi.advanceTimersByTime(2999);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(d.pending()).toBe(false);
  });

  it("连续事件重置静默期", () => {
    const fire = vi.fn();
    const d = createDebouncer({ quietMs: 3000, maxWaitMs: 30000, onFire: fire });
    d.touch();
    vi.advanceTimersByTime(2000);
    d.touch(); // 重置
    vi.advanceTimersByTime(2000);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("持续编辑不断重置时，maxWait 封顶必触发（防饿死）", () => {
    const fire = vi.fn();
    const d = createDebouncer({ quietMs: 3000, maxWaitMs: 10000, onFire: fire });
    // 每 2s 一次事件，静默期永远不满
    for (let t = 0; t < 9000; t += 2000) {
      d.touch();
      vi.advanceTimersByTime(2000);
    }
    expect(fire).toHaveBeenCalledTimes(1); // 10s 处由 maxWait 触发
  });

  it("触发后计时器全部清空，下一轮重新开始", () => {
    const fire = vi.fn();
    const d = createDebouncer({ quietMs: 1000, maxWaitMs: 5000, onFire: fire });
    d.touch();
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);
    // 第二轮
    d.touch();
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60000);
    expect(fire).toHaveBeenCalledTimes(2); // 无残留计时器
  });

  it("cancel 取消所有待触发", () => {
    const fire = vi.fn();
    const d = createDebouncer({ quietMs: 1000, maxWaitMs: 5000, onFire: fire });
    d.touch();
    d.cancel();
    vi.advanceTimersByTime(60000);
    expect(fire).not.toHaveBeenCalled();
  });
});

describe("文件监听", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir("watch");
    fs.mkdirSync(path.join(dir, ".git", "objects"), { recursive: true });
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const waitFor = async (cond: () => boolean, ms = 3000) => {
    const start = Date.now();
    while (!cond() && Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return cond();
  };

  it("内容文件改动触发事件；.git 内部与 pause 标记被过滤", async () => {
    const events: number[] = [];
    const w = startWatcher(dir, () => events.push(Date.now()));
    expect(w).not.toBeNull();
    try {
      // macOS FSEvents 会回放 watch 启动前的历史事件（beforeEach 的 mkdir），
      // 先静置并清空，再开始断言
      await new Promise((r) => setTimeout(r, 800));
      events.length = 0;

      // .git 内部写入 → 不触发
      fs.writeFileSync(path.join(dir, ".git", "objects", "x"), "y");
      fs.writeFileSync(path.join(dir, ".knowbase-pause"), "");
      await new Promise((r) => setTimeout(r, 500));
      expect(events.length).toBe(0);

      // 内容写入（含子目录）→ 触发
      fs.writeFileSync(path.join(dir, "sub", "note.md"), "hello");
      const got = await waitFor(() => events.length > 0);
      expect(got).toBe(true);
    } finally {
      w?.close();
    }
  });
});
