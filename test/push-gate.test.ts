import { describe, it, expect } from "vitest";
import { PushGate, PROBE_INTERVAL_MS } from "../src/push-gate.js";

const T0 = 1_800_000_000_000; // 固定基准时刻，避免依赖真实时钟
const DENIED = { ok: false, denied: true };
const OK = { ok: true, denied: false };
const TRANSIENT = { ok: false, denied: false };

describe("PushGate", () => {
  it("未熔断时一律放行", () => {
    const gate = new PushGate();
    expect(gate.shouldAttempt(T0)).toBe(true);
    expect(gate.blocked).toBe(false);
    expect(gate.snapshot()).toBeUndefined();
  });

  it("首次 denied 立即熔断并报告状态翻转", () => {
    const gate = new PushGate();
    expect(gate.record(DENIED, "no write access", T0)).toBe("blocked");
    expect(gate.blocked).toBe(true);
  });

  it("熔断后在窗口内不放行，到点放行一次", () => {
    const gate = new PushGate();
    gate.record(DENIED, "no write access", T0);
    expect(gate.shouldAttempt(T0 + PROBE_INTERVAL_MS - 1000)).toBe(false);
    expect(gate.shouldAttempt(T0 + PROBE_INTERVAL_MS)).toBe(true);
    expect(gate.shouldAttempt(T0 + PROBE_INTERVAL_MS + 1000)).toBe(true);
  });

  it("探测再次 denied 则窗口顺延，且不再报翻转（避免重复写日志）", () => {
    const gate = new PushGate();
    gate.record(DENIED, "no write access", T0);
    const probeAt = T0 + PROBE_INTERVAL_MS;
    expect(gate.record(DENIED, "no write access", probeAt)).toBe("unchanged");
    expect(gate.shouldAttempt(probeAt + 1000)).toBe(false);
    expect(gate.shouldAttempt(probeAt + PROBE_INTERVAL_MS)).toBe(true);
  });

  it("熔断期间探测因网络失败也顺延窗口，不退回每周期重试", () => {
    const gate = new PushGate();
    gate.record(DENIED, "no write access", T0);
    const probeAt = T0 + PROBE_INTERVAL_MS;
    expect(gate.record(TRANSIENT, "could not resolve host", probeAt)).toBe("unchanged");
    expect(gate.shouldAttempt(probeAt + 1000)).toBe(false);
    expect(gate.blocked).toBe(true);
  });

  it("未熔断时的网络失败不触发熔断", () => {
    const gate = new PushGate();
    expect(gate.record(TRANSIENT, "could not resolve host", T0)).toBe("unchanged");
    expect(gate.blocked).toBe(false);
    expect(gate.shouldAttempt(T0)).toBe(true);
  });

  it("push 成功即解除熔断并报告恢复", () => {
    const gate = new PushGate();
    gate.record(DENIED, "no write access", T0);
    expect(gate.record(OK, "", T0 + PROBE_INTERVAL_MS)).toBe("recovered");
    expect(gate.blocked).toBe(false);
    expect(gate.snapshot()).toBeUndefined();
    expect(gate.shouldAttempt(T0 + PROBE_INTERVAL_MS)).toBe(true);
  });

  it("未熔断时的成功不报恢复", () => {
    const gate = new PushGate();
    expect(gate.record(OK, "", T0)).toBe("unchanged");
  });

  it("snapshot 输出 ISO 时间与原因，供 status 展示", () => {
    const gate = new PushGate();
    gate.record(DENIED, "GitLab: You are not allowed to push code to this project.", T0);
    const snap = gate.snapshot();
    expect(snap).toEqual({
      since: new Date(T0).toISOString(),
      reason: "GitLab: You are not allowed to push code to this project.",
      nextProbeAt: new Date(T0 + PROBE_INTERVAL_MS).toISOString(),
    });
  });

  it("熔断持续期间 since 保持首次时刻不变", () => {
    const gate = new PushGate();
    gate.record(DENIED, "a", T0);
    gate.record(DENIED, "b", T0 + PROBE_INTERVAL_MS);
    expect(gate.snapshot()!.since).toBe(new Date(T0).toISOString());
  });
});
