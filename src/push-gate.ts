import type { PushBlocked } from "./config.js";

/** 熔断期间的探测间隔：固定 5 分钟，不做递增退避。 */
export const PROBE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * push 熔断器。
 *
 * 把「重试必然失败」的 push（无写权限 / 凭证失效 / 保护分支）从每个同步周期
 * 一次降到每 5 分钟一次静默探测，权限补上后自动解除。
 *
 * 只掐 push：commit / fetch / merge 不受影响，无写权限的成员因此降级为一个
 * 可用的只读模式——本地改动仍安全提交在本机，团队更新照常拉取。
 *
 * 状态只活在守护进程内存里，不持久化：重启后先试一次再熔断，代价是一次多余
 * 请求，换来无需维护状态文件、也无需处理其损坏。因此前台 `knowbase sync`
 * （另一个进程、不持有熔断器）天然无视熔断，正是想要的行为。
 */
export class PushGate {
  private blockedSince: number | null = null;
  private reason = "";
  private nextProbeAt = 0;

  get blocked(): boolean {
    return this.blockedSince !== null;
  }

  /** 本轮是否应该尝试 push。熔断中仅在探测窗口到点时放行一次。 */
  shouldAttempt(now: number): boolean {
    if (this.blockedSince === null) return true;
    return now >= this.nextProbeAt;
  }

  /**
   * 回喂一次 push 结果。返回状态是否翻转，调用方据此决定要不要写日志——
   * 静默探测必须不写日志，否则噪声与修复前无异。
   */
  record(
    outcome: { ok: boolean; denied: boolean },
    reason: string,
    now: number
  ): "blocked" | "recovered" | "unchanged" {
    if (outcome.ok) {
      if (this.blockedSince === null) return "unchanged";
      this.blockedSince = null;
      this.reason = "";
      this.nextProbeAt = 0;
      return "recovered";
    }
    if (outcome.denied) {
      const first = this.blockedSince === null;
      if (first) this.blockedSince = now;
      this.reason = reason;
      this.nextProbeAt = now + PROBE_INTERVAL_MS;
      return first ? "blocked" : "unchanged";
    }
    // 非 denied 失败：未熔断时交回原有的下周期重试逻辑，不熔断；
    // 熔断中则同样顺延窗口——否则窗口不前移，下一周期立刻又试，退回每 60 秒一次。
    if (this.blockedSince !== null) this.nextProbeAt = now + PROBE_INTERVAL_MS;
    return "unchanged";
  }

  snapshot(): PushBlocked | undefined {
    if (this.blockedSince === null) return undefined;
    return {
      since: new Date(this.blockedSince).toISOString(),
      reason: this.reason,
      nextProbeAt: new Date(this.nextProbeAt).toISOString(),
    };
  }
}
