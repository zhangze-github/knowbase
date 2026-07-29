import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BLOCK_START,
  BLOCK_END,
  buildBlock,
  upsertBlock,
  stripBlock,
  installAgentConfig,
  uninstallAgentConfig,
  agentTargets,
} from "../src/agent-config.js";
import { tmpDir } from "./helpers.js";

let home: string;

beforeEach(() => {
  home = tmpDir("agent");
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("托管区块 upsert / strip", () => {
  it("空内容 → 仅区块", () => {
    const b = buildBlock("/kb");
    expect(upsertBlock("", b).trim()).toBe(b.trim());
  });

  it("已有内容 → 追加且保留原内容", () => {
    const b = buildBlock("/kb");
    const out = upsertBlock("# 我的偏好\n用中文回答\n", b);
    expect(out).toContain("我的偏好");
    expect(out).toContain(BLOCK_START);
    expect(out).toContain("/kb");
  });

  it("已有旧区块 → 原地替换而非重复", () => {
    const out1 = upsertBlock("# 偏好\n", buildBlock("/old"));
    const out2 = upsertBlock(out1, buildBlock("/new"));
    expect(out2).toContain("/new");
    expect(out2).not.toContain("/old");
    // 只出现一次
    expect(out2.split(BLOCK_START).length - 1).toBe(1);
    expect(out2).toContain("偏好");
  });

  it("strip 移除区块保留其余内容", () => {
    const withBlock = upsertBlock("# 偏好\n用中文\n", buildBlock("/kb"));
    const { content, removed } = stripBlock(withBlock);
    expect(removed).toBe(true);
    expect(content).toContain("偏好");
    expect(content).not.toContain(BLOCK_START);
    expect(content).not.toContain(BLOCK_END);
    expect(content).not.toContain("/kb");
  });

  it("strip 无区块时不改动", () => {
    const { content, removed } = stripBlock("# 偏好\n");
    expect(removed).toBe(false);
    expect(content).toBe("# 偏好\n");
  });
});

describe("installAgentConfig / uninstallAgentConfig", () => {
  it("为 Claude Code 与 Codex 创建/更新，且保留已有内容；uninstall 清除", () => {
    // 预置一个已有的 Claude 全局偏好文件
    const claude = path.join(home, ".claude", "CLAUDE.md");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, "# 全局偏好\n始终用中文回答。\n");

    const changes = installAgentConfig("/Users/x/knowledge-base", home);
    const byName = Object.fromEntries(changes.map((c) => [c.name, c]));
    expect(byName["Claude Code"].action).toBe("updated");
    expect(byName["Codex"].action).toBe("created");

    // Claude 文件：原偏好保留 + 区块写入
    const claudeContent = fs.readFileSync(claude, "utf8");
    expect(claudeContent).toContain("始终用中文回答");
    expect(claudeContent).toContain("/Users/x/knowledge-base");

    // Codex 文件：新建
    const codex = path.join(home, ".codex", "AGENTS.md");
    expect(fs.existsSync(codex)).toBe(true);
    expect(fs.readFileSync(codex, "utf8")).toContain("/Users/x/knowledge-base");

    // 幂等：再次 install 不重复
    const again = installAgentConfig("/Users/x/knowledge-base", home);
    expect(again.every((c) => c.action === "unchanged")).toBe(true);

    // uninstall：移除区块，保留原偏好
    const removals = uninstallAgentConfig(home);
    expect(removals.filter((r) => r.removed).length).toBe(2);
    const after = fs.readFileSync(claude, "utf8");
    expect(after).toContain("始终用中文回答");
    expect(after).not.toContain("/Users/x/knowledge-base");
  });

  it("agentTargets 指向正确的全局路径", () => {
    const t = agentTargets(home);
    expect(t.map((x) => x.file)).toEqual([
      path.join(home, ".claude", "CLAUDE.md"),
      path.join(home, ".codex", "AGENTS.md"),
    ]);
  });
});
