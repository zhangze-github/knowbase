import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Logger } from "../src/config.js";
import { installedVersion, runDaemon, upgradeDetected } from "../src/sync-engine.js";
import { tmpDir } from "./helpers.js";

let root: string;
beforeEach(() => {
  root = tmpDir("upgrade");
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "config"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("升级检测", () => {
  it("两侧版本都读得到且不同才算升级", () => {
    expect(upgradeDetected("1.2.0", "1.3.0")).toBe(true);
    expect(upgradeDetected("1.2.0", "1.2.0")).toBe(false);
    expect(upgradeDetected(null, "1.3.0")).toBe(false);
    expect(upgradeDetected("1.2.0", null)).toBe(false);
  });

  it("读取包根目录 package.json 的版本；读不到返回 null", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
    expect(installedVersion()).toBe(pkg.version);
    expect(installedVersion(path.join(root, "nope.json"))).toBe(null);
    fs.writeFileSync(path.join(root, "half.json"), '{"vers');
    expect(installedVersion(path.join(root, "half.json"))).toBe(null);
  });

  it("守护进程发现磁盘上的版本变了 → 记日志并交给重启逻辑，然后退出循环", async () => {
    const kb = path.join(root, "kb");
    fs.mkdirSync(kb);
    const logFile = path.join(root, "daemon.log");
    const versions = ["1.2.0", "1.2.0", "1.3.0"];
    const onUpgrade = vi.fn();
    await runDaemon(
      // 关掉提示词与 skills：runCycle 用默认 home，测试不能写真实的 ~/.claude
      { repoUrl: "x", dir: kb, interval: 0, branch: "main", watch: false, agentConfig: false, skills: false },
      { logger: new Logger(logFile), readVersion: () => versions.shift() ?? "1.3.0", onUpgrade }
    );
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(logFile, "utf8")).toContain("1.2.0 → 1.3.0");
  });
});
