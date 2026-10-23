import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { ExporterHealth } from "../src/exporter/health.js";
import { runExporterDaemon, type ExportResult } from "../src/exporter/exporter.js";
import { Logger } from "../src/config.js";
import { tmpDir, makeEmptyOrigin, cloneWorkdir, denyPush, allowPush } from "./helpers.js";

const success: ExportResult = { exported: 0, moved: 0, removed: 0, committed: true, pushed: true };

describe("exporter push health", () => {
  it("failed or unconfirmed pushes cannot refresh success; recovery clears the error", () => {
    const dir = tmpDir("exporter-health");
    const file = path.join(dir, "state/health.json");
    let now = new Date("2026-10-23T00:00:00Z");
    const health = new ExporterHealth(file, () => now);
    const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
    expect(read().last_success_at).toBeUndefined();
    health.record(success);
    expect(read().last_success_at).toBe("2026-10-23T00:00:00.000Z");

    now = new Date("2026-10-23T00:01:00Z");
    health.record({ ...success, pushed: false, error: "push rejected" });
    expect(read()).toMatchObject({ last_success_at: "2026-10-23T00:00:00.000Z", last_cycle_at: "2026-10-23T00:01:00.000Z", last_error: "push rejected" });
    now = new Date("2026-10-23T00:02:00Z");
    health.record({ ...success, pushed: false, committed: false });
    expect(read().last_success_at).toBe("2026-10-23T00:00:00.000Z");
    now = new Date("2026-10-23T00:03:00Z");
    health.record(success);
    expect(read().last_success_at).toBe("2026-10-23T00:03:00.000Z");
    expect(read().last_error).toBeUndefined();
    // A restarted process must not inherit the previous process's healthy push.
    new ExporterHealth(file, () => now);
    expect(read().last_success_at).toBeUndefined();
    expect(fs.readdirSync(path.dirname(file))).toEqual(["health.json"]);
  });

  it("daemon reports failed publication and the next successful retry through the cycle callback", async () => {
    const root = tmpDir("exporter-health-daemon");
    const bare = makeEmptyOrigin(root);
    const dir = path.join(root, "work");
    cloneWorkdir(bare, dir);
    denyPush(bare);
    const file = path.join(root, "health.json");
    const health = new ExporterHealth(file);
    const reports: { pushed: boolean; error?: string; summary: string }[] = [];
    await runExporterDaemon(
      { repoDir: dir, branch: "main", spaceId: "spc", host: "acme.feishu.cn" },
      { client: { listAllSpaceNodes: async () => [], listDocBlocks: async () => [] }, logger: new Logger(path.join(root, "exporter.log")) },
      {
        intervalSec: 1, maxCycles: 2,
        sleep: async () => {
          const state = JSON.parse(fs.readFileSync(file, "utf8"));
          expect(state.last_error).toContain("push");
          expect(state.last_success_at).toBeUndefined();
          allowPush(bare);
        },
        onCycle: (result, summary) => { health.record(result); reports.push({ pushed: result.pushed, error: result.error, summary }); },
      }
    );
    expect(reports).toHaveLength(2);
    expect(reports[0].pushed).toBe(false);
    expect(reports[0].summary).toContain("error=");
    expect(reports[1].pushed).toBe(true);
    const final = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(final.last_success_at).toBeTruthy();
    expect(final.last_error).toBeUndefined();
  });
});
