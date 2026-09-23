import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  readKbTree,
  TREE_MAX_BYTES,
  DIR_HEAD,
  DIR_TAIL,
  MIN_HIDDEN,
  MirrorBlockInfo,
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

describe("目录树读取", () => {
  let kb: string;
  beforeEach(() => {
    kb = tmpDir("kb");
  });
  afterEach(() => {
    fs.rmSync(kb, { recursive: true, force: true });
  });

  it("嵌套结构：目录先于文件、各自排序、目录带 / 后缀、缩进两格", () => {
    fs.mkdirSync(path.join(kb, "b-dir", "sub"), { recursive: true });
    fs.writeFileSync(path.join(kb, "a.md"), "a");
    fs.writeFileSync(path.join(kb, "z.txt"), "z");
    fs.writeFileSync(path.join(kb, "b-dir", "x.md"), "x");
    fs.writeFileSync(path.join(kb, "b-dir", "sub", "y.md"), "y");

    const r = readKbTree(kb);
    expect(r.text).toBe(
      ["b-dir/", "  sub/", "    y.md", "  x.md", "a.md", "z.txt"].join("\n")
    );
    expect(r.files).toBe(4);
    expect(r.truncated).toBe(false);
  });

  it("跳过点开头的条目与 node_modules", () => {
    fs.writeFileSync(path.join(kb, ".gitignore"), "x");
    fs.writeFileSync(path.join(kb, ".knowbase-mirror.json"), "{}");
    fs.mkdirSync(path.join(kb, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(kb, "node_modules", "pkg", "a.js"), "x");
    fs.writeFileSync(path.join(kb, "README.md"), "x");

    const r = readKbTree(kb);
    expect(r.text).toBe("README.md");
    expect(r.files).toBe(1);
  });

  it("空目录 → text 为 null", () => {
    const r = readKbTree(kb);
    expect(r.text).toBe(null);
    expect(r.files).toBe(0);
    expect(r.bytes).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("目录不存在 → 不抛错，text 为 null", () => {
    const r = readKbTree(path.join(kb, "nope"));
    expect(r.text).toBe(null);
    expect(r.files).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "文件名含 KNOWBASE:END 字样被中和",
    () => {
      fs.writeFileSync(path.join(kb, "KNOWBASE:END.md"), "x");
      const r = readKbTree(kb);
      expect(r.text).not.toContain("KNOWBASE:END");
      expect(r.text).toContain("KNOWBASE_END.md");
    }
  );

  it("目录数过多仍可能超 8KB → truncated，含截断提示，正文行完整", () => {
    // 宽度折叠只约束单目录内的文件数，目录本身不折叠：造大量目录仍能撑爆字节上限，
    // 验证 TREE_MAX_BYTES 这层兜底在折叠之后依然有效。
    for (let i = 0; i < 2000; i++) {
      const d = `dir-${String(i).padStart(5, "0")}`;
      fs.mkdirSync(path.join(kb, d));
      fs.writeFileSync(path.join(kb, d, "a.md"), "x");
    }
    const r = readKbTree(kb);
    expect(r.truncated).toBe(true);
    expect(r.text!).toContain("已截断");
    const body = r.text!.split("\n\n…")[0];
    // 正文每一行都应完整（没有被从中间切断）
    expect(body.split("\n").every((l) => /^(dir-\d{5}\/|  a\.md)$/.test(l))).toBe(true);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(TREE_MAX_BYTES);
    expect(r.bytes).toBeGreaterThan(TREE_MAX_BYTES);
  });

  it("目录内文件数不超上限 → 全部列出，无折叠行", () => {
    const n = DIR_HEAD + DIR_TAIL;
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(kb, `f-${String(i).padStart(2, "0")}.md`), "x");
    }
    const r = readKbTree(kb);
    expect(r.text!.split("\n")).toHaveLength(n);
    expect(r.text).not.toContain("未列出");
    expect(r.hidden).toBe(0);
    expect(r.files).toBe(n);
  });

  it("超出上限但隐藏数不足 MIN_HIDDEN → 不折叠，全部列出", () => {
    // 折叠行本身要占约 50 字节，而一个文件名行约 45 字节：只藏一两篇是净亏，
    // 还白白让 agent 以为清单不完整。
    const n = DIR_HEAD + DIR_TAIL + MIN_HIDDEN - 1;
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(kb, `f-${String(i).padStart(2, "0")}.md`), "x");
    }
    const r = readKbTree(kb);
    expect(r.text!.split("\n")).toHaveLength(n);
    expect(r.text).not.toContain("未列出");
    expect(r.hidden).toBe(0);
    expect(r.files).toBe(n);
  });

  it("隐藏数刚好达到 MIN_HIDDEN → 开始折叠", () => {
    const n = DIR_HEAD + DIR_TAIL + MIN_HIDDEN;
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(kb, `f-${String(i).padStart(2, "0")}.md`), "x");
    }
    const r = readKbTree(kb);
    expect(r.text!.split("\n")).toHaveLength(DIR_HEAD + 1 + DIR_TAIL);
    expect(r.text).toContain(`另有 ${MIN_HIDDEN} 篇未列出`);
    expect(r.hidden).toBe(MIN_HIDDEN);
  });

  it("超出上限 → 保留前 5 与后 5，中间折叠成一行提示", () => {
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(kb, `f-${String(i).padStart(2, "0")}.md`), "x");
    }
    const r = readKbTree(kb);
    const lines = r.text!.split("\n");
    expect(lines).toHaveLength(DIR_HEAD + 1 + DIR_TAIL);
    expect(lines.slice(0, DIR_HEAD)).toEqual([
      "f-00.md",
      "f-01.md",
      "f-02.md",
      "f-03.md",
      "f-04.md",
    ]);
    expect(lines.slice(DIR_HEAD + 1)).toEqual([
      "f-20.md",
      "f-21.md",
      "f-22.md",
      "f-23.md",
      "f-24.md",
    ]);
    // 折叠行必须同时说清「隐藏了多少」与「怎么看到全部」
    expect(lines[DIR_HEAD]).toContain("另有 15 篇未列出");
    expect(lines[DIR_HEAD]).toContain("共 25 篇");
    expect(lines[DIR_HEAD]).toContain("grep");
    expect(r.hidden).toBe(15);
    // 计数含被折叠隐藏的文件：status 要报知识库的真实规模
    expect(r.files).toBe(25);
  });

  it("折叠按目录独立生效，父目录折叠不影响子目录；折叠行缩进与同级文件一致", () => {
    fs.mkdirSync(path.join(kb, "sub"));
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(kb, `f-${String(i).padStart(2, "0")}.md`), "x");
    }
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(kb, "sub", `s-${i}.md`), "x");
    }
    const r = readKbTree(kb);
    const lines = r.text!.split("\n");
    // 子目录只有 3 篇，全列
    expect(lines).toContain("  s-0.md");
    expect(lines).toContain("  s-2.md");
    // 根目录折叠，且折叠行不带缩进（与根下文件同级）
    const fold = lines.find((l) => l.includes("未列出"))!;
    expect(fold.startsWith(" ")).toBe(false);
    expect(r.hidden).toBe(20);
    expect(r.files).toBe(33);
  });

  it("深度不受限制：深层目录照常递归到底", () => {
    fs.mkdirSync(path.join(kb, "a", "b", "c", "d"), { recursive: true });
    fs.writeFileSync(path.join(kb, "a", "b", "c", "d", "deep.md"), "x");
    const r = readKbTree(kb);
    expect(r.text).toContain("        deep.md");
    expect(r.files).toBe(1);
  });

  it("有界性：单目录文件数从 100 涨到 5000，注入行数不变", () => {
    const linesFor = (n: number): number => {
      fs.rmSync(kb, { recursive: true, force: true });
      fs.mkdirSync(kb, { recursive: true });
      for (let i = 0; i < n; i++) {
        fs.writeFileSync(path.join(kb, `f-${String(i).padStart(5, "0")}.md`), "x");
      }
      return readKbTree(kb).text!.split("\n").length;
    };
    expect(linesFor(5000)).toBe(linesFor(100));
  });
});

describe("区块内嵌目录树", () => {
  let kb: string;
  beforeEach(() => {
    kb = tmpDir("kb");
  });
  afterEach(() => {
    fs.rmSync(kb, { recursive: true, force: true });
  });

  const claudeFile = () => path.join(home, ".claude", "CLAUDE.md");

  it("有树 → 含目录树标题、文件名与导航段", () => {
    const b = buildBlock("/kb", "角色/\n  角色定义与职责.md");
    expect(b).toContain("### 知识库目录树");
    expect(b).toContain("角色定义与职责.md");
    expect(b).toContain("**导航**");
  });

  it("空库→回退（暂无）：无树标题、仍有导航段", () => {
    const b = buildBlock("/kb", null);
    expect(b).not.toContain("### 知识库目录树");
    expect(b).toContain("暂无");
    expect(b).toContain("**导航**");
  });

  it("区块告诉 agent 可执行流程该沉淀到 skills/", () => {
    // 不告诉 agent 这个位置存在，它永远只会往 md 里写散文，不会产出 skill
    const b = buildBlock("/kb");
    expect(b).toContain("skills/");
    expect(b).toContain("SKILL.md");
    expect(b).toContain("org-");
  });

  it.skipIf(process.platform === "win32")(
    "文件名含标记字样时 sync→strip 往返不吞用户内容",
    () => {
      fs.writeFileSync(path.join(kb, "KNOWBASE:END.md"), "x");
      fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
      fs.writeFileSync(claudeFile(), "# 偏好\n用中文回答\n");

      syncAgentConfig(kb, home);
      const written = fs.readFileSync(claudeFile(), "utf8");
      // 真正的区块结束标记只应出现一次：文件名里的标记字样已被中和
      expect(written.split("KNOWBASE:END").length - 1).toBe(1);

      const { content, removed } = stripBlock(written);
      expect(removed).toBe(true);
      expect(content).toContain("用中文回答");
      expect(content).not.toContain("KNOWBASE");
    }
  );

  it("内容未变 → unchanged 且不落盘", async () => {
    fs.writeFileSync(path.join(kb, "角色定义.md"), "内容");
    syncAgentConfig(kb, home);
    const before = fs.statSync(claudeFile()).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));

    const again = syncAgentConfig(kb, home);
    expect(again.every((c) => c.action === "unchanged")).toBe(true);
    expect(fs.statSync(claudeFile()).mtimeMs).toBe(before);
  });

  it("新增文件 → 区块随之更新，旧内容消失", () => {
    fs.writeFileSync(path.join(kb, "旧条目.md"), "旧");
    syncAgentConfig(kb, home);

    fs.rmSync(path.join(kb, "旧条目.md"));
    fs.writeFileSync(path.join(kb, "新条目.md"), "新");
    const changes = syncAgentConfig(kb, home);
    expect(changes.every((c) => c.action === "updated")).toBe(true);

    const content = fs.readFileSync(claudeFile(), "utf8");
    expect(content).toContain("新条目");
    expect(content).not.toContain("旧条目");
  });

  it("写入后不残留临时文件", () => {
    fs.writeFileSync(path.join(kb, "README.md"), "内容");
    syncAgentConfig(kb, home);
    const left = fs.readdirSync(path.join(home, ".claude"));
    expect(left.some((f) => f.includes("knowbase-tmp"))).toBe(false);
    expect(left).toContain("CLAUDE.md");
  });

  it("空知识库 → 区块走回退文案（与 status 口径一致）", () => {
    syncAgentConfig(kb, home);
    const content = fs.readFileSync(claudeFile(), "utf8");
    expect(content).not.toContain("### 知识库目录树");
    expect(content).toContain("暂无");
  });
});

describe("buildBlock 空树口径", () => {
  it("空串 / 纯空白树 → 与 null 同样走回退文案", () => {
    for (const empty of ["", "   \n\t\n"]) {
      const b = buildBlock("/kb", empty);
      expect(b).not.toContain("### 知识库目录树");
      expect(b).toContain("暂无");
    }
  });
});

describe("upsertBlock 结束标记缺失", () => {
  it("有 START 无 END → 返回 null（不截断用户内容）", () => {
    const broken = `# 偏好\n${BLOCK_START}\n半截区块\n\n# 我后面的重要内容\n别删我\n`;
    expect(upsertBlock(broken, buildBlock("/kb"))).toBe(null);
  });
});

describe("原子写安全性（并发 / 软链）", () => {
  let kb: string;
  beforeEach(() => {
    kb = tmpDir("kb");
    fs.writeFileSync(path.join(kb, "角色定义.md"), "角色定义与职责");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(kb, { recursive: true, force: true });
  });

  const claudeFile = () => path.join(home, ".claude", "CLAUDE.md");

  it("C1: 临时文件名带 pid，不与其他进程算出同一路径", () => {
    // 旧实现用固定的 <file>.knowbase-tmp：daemon 的周期刷新与用户手跑的 init
    // 会算出同一个临时路径、交错写入再各自 rename。这里用一个目录占住旧路径，
    // 实现若仍用固定名，writeFileSync 会直接 EISDIR。
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude", "CLAUDE.md.knowbase-tmp"));

    const spy = vi.spyOn(fs, "writeFileSync");
    const changes = syncAgentConfig(kb, home);
    const tmpPaths = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((p) => p.includes("knowbase-tmp"));

    expect(changes.every((c) => c.action === "created")).toBe(true);
    expect(tmpPaths.length).toBeGreaterThan(0);
    expect(
      tmpPaths.every((p) => p.endsWith(`.knowbase-tmp-${process.pid}`))
    ).toBe(true);
    expect(fs.readFileSync(claudeFile(), "utf8")).toContain("角色定义");
  });

  it("C1: 写入过程失败 → 临时文件被清理，异常继续上抛", () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("模拟 rename 失败");
    });
    expect(() => syncAgentConfig(kb, home)).toThrow("模拟 rename 失败");
    vi.restoreAllMocks();

    const left = fs.readdirSync(path.join(home, ".claude"));
    expect(left.filter((f) => f.includes("knowbase-tmp"))).toEqual([]);
  });

  it("C2: 目标是软链时穿透写入，软链本身保持不变", () => {
    // dotfiles 仓库场景：~/.claude/CLAUDE.md 是指向仓库副本的软链。
    const repoCopy = path.join(home, "dotfiles", "CLAUDE.md");
    fs.mkdirSync(path.dirname(repoCopy), { recursive: true });
    fs.writeFileSync(repoCopy, "# 全局偏好\n始终用中文回答。\n");
    fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
    fs.symlinkSync(repoCopy, claudeFile());

    syncAgentConfig(kb, home);

    expect(fs.lstatSync(claudeFile()).isSymbolicLink()).toBe(true);
    const written = fs.readFileSync(repoCopy, "utf8");
    expect(written).toContain("角色定义");
    expect(written).toContain("始终用中文回答");
    // 临时文件应落在真实文件所在目录并已被 rename 掉
    expect(
      fs.readdirSync(path.dirname(repoCopy)).filter((f) => f.includes("knowbase-tmp"))
    ).toEqual([]);
  });

  it("C2: 悬空软链（目标尚未创建）同样保住软链，并建出目标文件", () => {
    // 先建软链、后建仓库副本是 dotfiles 的常见顺序；existsSync 对悬空软链返回
    // false，若据此当普通文件处理，rename 会把链换掉、仓库副本永远建不出来。
    const repoCopy = path.join(home, "dotfiles", "CLAUDE.md");
    fs.mkdirSync(path.dirname(repoCopy), { recursive: true });
    fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
    fs.symlinkSync(repoCopy, claudeFile());
    expect(fs.existsSync(claudeFile())).toBe(false); // 悬空

    syncAgentConfig(kb, home);

    expect(fs.lstatSync(claudeFile()).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(repoCopy)).toBe(true);
    expect(fs.readFileSync(repoCopy, "utf8")).toContain("角色定义");
  });

  it("C2: 两跳软链链路完整保住，只写到最末端的真实文件", () => {
    const repoCopy = path.join(home, "dotfiles", "CLAUDE.md");
    fs.mkdirSync(path.dirname(repoCopy), { recursive: true });
    fs.writeFileSync(repoCopy, "# 偏好\n");
    const mid = path.join(home, "mid-CLAUDE.md");
    fs.symlinkSync(repoCopy, mid);
    fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
    fs.symlinkSync(mid, claudeFile());

    syncAgentConfig(kb, home);

    expect(fs.lstatSync(claudeFile()).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(mid).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(repoCopy, "utf8")).toContain("角色定义");
  });

  it("I4: 结束标记缺失 → action=skipped，文件一字未动", () => {
    const broken = `# 偏好\n${BLOCK_START}\n半截区块\n\n# 我后面的重要内容\n别删我\n`;
    fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
    fs.writeFileSync(claudeFile(), broken);

    const changes = syncAgentConfig(kb, home);
    const byName = Object.fromEntries(changes.map((c) => [c.name, c]));
    expect(byName["Claude Code"].action).toBe("skipped");
    expect(fs.readFileSync(claudeFile(), "utf8")).toBe(broken);
    // Codex 侧不受影响，照常创建
    expect(byName["Codex"].action).toBe("created");
  });

  it("I1: onlyExisting 时无区块不创建、有区块照常刷新", () => {
    // 文件不存在 → 不创建
    const noneChanges = syncAgentConfig(kb, home, { onlyExisting: true });
    expect(noneChanges.every((c) => c.action === "unchanged")).toBe(true);
    expect(fs.existsSync(claudeFile())).toBe(false);

    // 文件存在但用户手动删掉了区块 → 不写回
    fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
    fs.writeFileSync(claudeFile(), "# 偏好\n我删掉了 knowbase 区块\n");
    expect(
      syncAgentConfig(kb, home, { onlyExisting: true }).every(
        (c) => c.action === "unchanged"
      )
    ).toBe(true);
    expect(fs.readFileSync(claudeFile(), "utf8")).not.toContain(BLOCK_START);

    // init 建过区块之后 → onlyExisting 正常刷新
    syncAgentConfig(kb, home);
    fs.writeFileSync(path.join(kb, "新条目.md"), "新条目内容");
    const refreshed = syncAgentConfig(kb, home, { onlyExisting: true });
    expect(refreshed.find((c) => c.name === "Claude Code")!.action).toBe("updated");
    expect(fs.readFileSync(claudeFile(), "utf8")).toContain("新条目");
  });
});

describe("镜像模式区块文案", () => {
  it("镜像变体：只读声明 + feishu_url 引导 + 平权自主归属，无专属 AI 目录", () => {
    const block = buildBlock("/kb", null, {});
    expect(block).toContain("只读本地镜像");
    expect(block).toContain("feishu_url");
    expect(block).toContain("lark-doc");
    // 产品决策：AI 与人编辑平权，agent 参照目录树自行判断归属，不设专属目录
    expect(block).toContain("平权");
    expect(block).toContain("自行判断");
    expect(block).not.toContain("Agent 沉淀");
    // 经典文案的「保存即同步」不得出现——那句话在镜像模式下是错误引导
    expect(block).not.toContain("保存即同步");
  });

  it("镜像变体：组织/个人内容边界写明", () => {
    const block = buildBlock("/kb", null, {});
    expect(block).toContain("复用价值");
    expect(block).toContain("个人偏好");
    expect(block).toContain("不进知识库");
    expect(block).toContain("询问用户");
  });

  it("第三参缺省：输出与经典文案逐字一致", () => {
    expect(buildBlock("/kb", "索引内容")).toBe(buildBlock("/kb", "索引内容", null));
    expect(buildBlock("/kb", "索引内容")).toContain("保存即同步");
  });
});
