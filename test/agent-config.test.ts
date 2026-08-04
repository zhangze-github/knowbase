import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BLOCK_START,
  BLOCK_END,
  buildBlock,
  upsertBlock,
  stripBlock,
  syncAgentConfig,
  uninstallAgentConfig,
  agentTargets,
  pickIndexName,
  readIndex,
  INDEX_MAX_BYTES,
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

describe("syncAgentConfig / uninstallAgentConfig", () => {
  it("为 Claude Code 与 Codex 创建/更新，且保留已有内容；uninstall 清除", () => {
    // 预置一个已有的 Claude 全局偏好文件
    const claude = path.join(home, ".claude", "CLAUDE.md");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, "# 全局偏好\n始终用中文回答。\n");

    const changes = syncAgentConfig("/Users/x/knowledge-base", home);
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
    const again = syncAgentConfig("/Users/x/knowledge-base", home);
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

describe("索引读取", () => {
  let kb: string;
  beforeEach(() => {
    kb = tmpDir("kb");
  });
  afterEach(() => {
    fs.rmSync(kb, { recursive: true, force: true });
  });

  it("pickIndexName 大小写不敏感", () => {
    expect(pickIndexName(["README.md", "Index.md"])).toBe("Index.md");
    expect(pickIndexName(["INDEX.MD"])).toBe("INDEX.MD");
    expect(pickIndexName(["readme.md", "角色"])).toBe(null);
    expect(pickIndexName([])).toBe(null);
  });

  it("pickIndexName 并存变体时取值确定：优先精确小写", () => {
    // 并存状态只可能出现在大小写敏感的文件系统上，无法在 macOS 落盘构造，
    // 因此选取逻辑写成纯函数，直接喂条目名数组来测。
    expect(pickIndexName(["Index.md", "index.md", "INDEX.md"])).toBe("index.md");
    // 无精确匹配 → 排序首个（'N' < 'n'，故 INDEX.md 在前）
    expect(pickIndexName(["Index.md", "INDEX.md"])).toBe("INDEX.md");
  });

  it("索引缺失 → 全部为空且不抛错", () => {
    const r = readIndex(kb);
    expect(r.name).toBe(null);
    expect(r.text).toBe(null);
    expect(r.bytes).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("目录不存在 → 不抛错", () => {
    const r = readIndex(path.join(kb, "nope"));
    expect(r.name).toBe(null);
  });

  it("读取 Index.md 并中和标记字样", () => {
    fs.writeFileSync(
      path.join(kb, "Index.md"),
      "# 索引\n- knowbase 的区块以 KNOWBASE:END 结尾\n"
    );
    const r = readIndex(kb);
    expect(r.name).toBe("Index.md");
    expect(r.text).toContain("# 索引");
    expect(r.text).not.toContain("KNOWBASE:END");
    expect(r.text).toContain("KNOWBASE_END");
    expect(r.truncated).toBe(false);
  });

  it("超 8KB → 行边界截断并附提示", () => {
    const line = "x".repeat(99) + "\n"; // 100 字节/行
    fs.writeFileSync(path.join(kb, "index.md"), line.repeat(100)); // 10000 字节
    const r = readIndex(kb);
    expect(r.bytes).toBe(10000);
    expect(r.truncated).toBe(true);
    expect(r.text!).toContain("已截断");
    // 正文部分（提示前）必须整行完整，且不超上限
    const body = r.text!.split("\n\n…")[0];
    expect(body.split("\n").every((l) => l === "x".repeat(99))).toBe(true);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(INDEX_MAX_BYTES);
  });

  it("单行超长且全文无换行 → 退化为按字节截断，不产生替换符", () => {
    fs.writeFileSync(path.join(kb, "index.md"), "x".repeat(10000)); // 无换行，10000 字节
    const r = readIndex(kb);
    expect(r.truncated).toBe(true);
    const body = r.text!.split("\n\n…")[0];
    expect(body).not.toContain("�");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(INDEX_MAX_BYTES);
  });

  it("截断点落在多字节字符中间 → 不产生替换符", () => {
    // 每个「汉」3 字节，4000 个 = 12000 字节，且全文无换行；
    // 8192 不是 3 的倍数，截断点必然落在某个字符中间。
    fs.writeFileSync(path.join(kb, "index.md"), "汉".repeat(4000));
    const r = readIndex(kb);
    expect(r.truncated).toBe(true);
    const body = r.text!.split("\n\n…")[0];
    expect(body).not.toContain("�");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(INDEX_MAX_BYTES);
  });
});

describe("区块内嵌索引", () => {
  let kb: string;
  beforeEach(() => {
    kb = tmpDir("kb");
  });
  afterEach(() => {
    fs.rmSync(kb, { recursive: true, force: true });
  });

  const claudeFile = () => path.join(home, ".claude", "CLAUDE.md");

  it("有索引 → 含索引标题、正文与导航段", () => {
    const b = buildBlock("/kb", "# 索引\n- 角色/：角色定义与职责");
    expect(b).toContain("### 知识库索引");
    expect(b).toContain("角色定义与职责");
    expect(b).toContain("**导航**");
  });

  it("无索引 → 回退文案、无索引标题、仍有导航段", () => {
    const b = buildBlock("/kb", null);
    expect(b).not.toContain("### 知识库索引");
    expect(b).toContain("暂无");
    expect(b).toContain("**导航**");
  });

  it("索引含标记字样时 sync→strip 往返不吞用户内容", () => {
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n区块以 KNOWBASE:END 收尾\n");
    fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
    fs.writeFileSync(claudeFile(), "# 偏好\n用中文回答\n");

    syncAgentConfig(kb, home);
    const { content, removed } = stripBlock(fs.readFileSync(claudeFile(), "utf8"));
    expect(removed).toBe(true);
    expect(content).toContain("用中文回答");
    expect(content).not.toContain("KNOWBASE");
  });

  it("内容未变 → unchanged 且不落盘", async () => {
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n- 条目\n");
    syncAgentConfig(kb, home);
    const before = fs.statSync(claudeFile()).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));

    const again = syncAgentConfig(kb, home);
    expect(again.every((c) => c.action === "unchanged")).toBe(true);
    expect(fs.statSync(claudeFile()).mtimeMs).toBe(before);
  });

  it("索引变化 → 区块随之更新，旧内容消失", () => {
    const idx = path.join(kb, "index.md");
    fs.writeFileSync(idx, "# 索引\n- 旧条目\n");
    syncAgentConfig(kb, home);

    fs.writeFileSync(idx, "# 索引\n- 新条目\n");
    const changes = syncAgentConfig(kb, home);
    expect(changes.every((c) => c.action === "updated")).toBe(true);

    const content = fs.readFileSync(claudeFile(), "utf8");
    expect(content).toContain("新条目");
    expect(content).not.toContain("旧条目");
  });

  it("写入后不残留临时文件", () => {
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n");
    syncAgentConfig(kb, home);
    const left = fs.readdirSync(path.join(home, ".claude"));
    expect(left.some((f) => f.includes("knowbase-tmp"))).toBe(false);
    expect(left).toContain("CLAUDE.md");
  });
});
