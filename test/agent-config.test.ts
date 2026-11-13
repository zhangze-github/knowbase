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
  readKbMap,
  MAP_MAX_BYTES,
  MAP_MAX_DEPTH,
  KB_SKILL_NAME,
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

describe("目录地图读取", () => {
  let kb: string;
  beforeEach(() => {
    kb = tmpDir("kb");
  });
  afterEach(() => {
    fs.rmSync(kb, { recursive: true, force: true });
  });

  it("只列目录与递归篇数，不列文件；目录排序、缩进两格", () => {
    fs.mkdirSync(path.join(kb, "b-dir", "sub"), { recursive: true });
    fs.mkdirSync(path.join(kb, "a-dir"));
    fs.writeFileSync(path.join(kb, "a.md"), "a");
    fs.writeFileSync(path.join(kb, "a-dir", "q.md"), "q");
    fs.writeFileSync(path.join(kb, "b-dir", "x.md"), "x");
    fs.writeFileSync(path.join(kb, "b-dir", "sub", "y.md"), "y");

    const r = readKbMap(kb);
    expect(r.text).toBe(["a-dir/（1）", "b-dir/（2）", "  sub/（1）"].join("\n"));
    expect(r.files).toBe(4);
    expect(r.dirs).toBe(3);
    expect(r.rootFiles).toBe(1);
    expect(r.text).not.toContain(".md");
    expect(r.truncated).toBe(false);
  });

  it("跳过点开头的条目、node_modules 与仓库根 skills，保留业务文档中同名目录", () => {
    fs.writeFileSync(path.join(kb, ".knowbase-mirror.json"), "{}");
    fs.mkdirSync(path.join(kb, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(kb, "node_modules", "pkg", "a.js"), "x");
    fs.mkdirSync(path.join(kb, "skills/deploy"), { recursive: true });
    fs.writeFileSync(path.join(kb, "skills/deploy/SKILL.md"), "team skill");
    fs.mkdirSync(path.join(kb, "项目/skills"), { recursive: true });
    fs.writeFileSync(path.join(kb, "项目/skills/培训.md"), "business knowledge");

    const r = readKbMap(kb);
    expect(r.text).toBe("项目/（1）\n  skills/（1）");
    expect(r.files).toBe(1);
  });

  it("空库 / 只有团队 skills / 目录不存在 → text 为 null，不抛错", () => {
    expect(readKbMap(kb).text).toBe(null);
    expect(readKbMap(path.join(kb, "nope")).files).toBe(0);
    fs.mkdirSync(path.join(kb, "skills/deploy"), { recursive: true });
    fs.writeFileSync(path.join(kb, "skills/deploy/SKILL.md"), "team skill");
    expect(readKbMap(kb).files).toBe(0);
  });

  it("只有根目录文件 → 有文件但无地图文本", () => {
    fs.writeFileSync(path.join(kb, "a.md"), "a");
    const r = readKbMap(kb);
    expect(r).toMatchObject({ text: null, files: 1, depth: 0, rootFiles: 1 });
    expect(buildBlock("/kb", r)).toContain("共 1 篇，均在根目录下");
  });

  it.skipIf(process.platform === "win32")("目录名含 KNOWBASE:END 字样被中和", () => {
    fs.mkdirSync(path.join(kb, "KNOWBASE:END"));
    fs.writeFileSync(path.join(kb, "KNOWBASE:END", "a.md"), "x");
    const r = readKbMap(kb);
    expect(r.text).not.toContain("KNOWBASE:END");
    expect(r.text).toContain("KNOWBASE_END/");
  });

  it("超预算时自动减少展开层数，而不是截断", () => {
    // 40 个顶层目录，各带 2 层长名子目录：全展开超预算，只展开 1 层放得下
    for (let i = 0; i < 40; i++) {
      const d = path.join(kb, `topic-${String(i).padStart(2, "0")}`, "second-level-directory-name", "third-level-directory-name");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "a.md"), "x");
    }
    const r = readKbMap(kb);
    expect(r.truncated).toBe(false);
    expect(r.depth).toBe(1);
    expect(r.depth).toBeLessThan(MAP_MAX_DEPTH);
    expect(r.text).toContain("topic-39/（1）");
    expect(r.text).not.toContain("second-level");
    expect(Buffer.byteLength(r.text!, "utf8")).toBeLessThanOrEqual(MAP_MAX_BYTES);
  });

  it("顶层目录本身就超预算 → 按行截断并提示，正文行完整", () => {
    for (let i = 0; i < 500; i++) {
      const d = `dir-${String(i).padStart(5, "0")}`;
      fs.mkdirSync(path.join(kb, d));
      fs.writeFileSync(path.join(kb, d, "a.md"), "x");
    }
    const r = readKbMap(kb);
    expect(r.truncated).toBe(true);
    expect(r.depth).toBe(1);
    const lines = r.text!.split("\n");
    expect(lines.at(-1)).toContain("已截断");
    expect(lines.slice(0, -1).every((l) => /^dir-\d{5}\/（1）$/.test(l))).toBe(true);
  });

  it("有界性：文档数从 100 涨到 3000，地图与常驻区块大小不变", () => {
    const sizeFor = (n: number): number => {
      fs.rmSync(kb, { recursive: true, force: true });
      for (let i = 0; i < n; i++) {
        const d = path.join(kb, `领域-${i % 8}`, `主题-${i % 5}`);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, `doc-${String(i).padStart(5, "0")}.md`), "x");
      }
      // 篇数会变，比较时把数字抹掉
      return buildBlock("/kb", readKbMap(kb)).replace(/\d+/g, "N").length;
    };
    expect(sizeFor(3000)).toBe(sizeFor(100));
  });
});

describe("常驻区块", () => {
  let kb: string;
  beforeEach(() => {
    kb = tmpDir("kb");
  });
  afterEach(() => {
    fs.rmSync(kb, { recursive: true, force: true });
  });

  const claudeFile = () => path.join(home, ".claude", "CLAUDE.md");

  it("有地图 → 含地图标题、目录、篇数与查找规则", () => {
    fs.mkdirSync(path.join(kb, "角色"));
    fs.writeFileSync(path.join(kb, "角色", "角色定义与职责.md"), "x");
    const b = buildBlock("/kb", readKbMap(kb));
    expect(b).toContain("### 目录地图");
    expect(b).toContain("角色/（1）");
    expect(b).not.toContain("角色定义与职责.md");
    expect(b).toContain("知识库里没有");
    expect(b).toContain(`skill \`${KB_SKILL_NAME}\``);
  });

  it("空库→回退（暂无）：无地图标题、仍有查找规则", () => {
    for (const b of [buildBlock("/kb", null), buildBlock("/kb"), buildBlock("/kb", readKbMap(kb))]) {
      expect(b).not.toContain("### 目录地图");
      expect(b).toContain("暂无");
      expect(b).toContain("**怎么查**");
    }
  });

  it("只放常驻必需内容：写入流程与沉淀标准在 skill 里，不在区块里", () => {
    const b = buildBlock("/kb", null);
    expect(b).toContain("只读本地镜像");
    expect(b).not.toContain("lark-doc");
    expect(b).not.toContain("--as bot");
    expect(b).not.toContain("保存即同步");
    // 团队 skill 边界仍要写明：skills/ 不走飞书
    expect(b).toContain("skills/");
    expect(b).toContain("org-");
  });

  it("预算：常驻区块不超过 3.5KB、Hermes 的 3,700 字符截断线之下", () => {
    for (let i = 0; i < 200; i++) {
      const d = path.join(kb, `一级目录-${i % 12}`, `二级目录名字比较长的主题-${i % 7}`, `三级-${i % 3}`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `文档-${i}.md`), "x");
    }
    const b = buildBlock(kb, readKbMap(kb));
    expect(Buffer.byteLength(b, "utf8")).toBeLessThanOrEqual(3584);
    expect(b.length).toBeLessThan(3700);
  });

  it.skipIf(process.platform === "win32")(
    "目录名含标记字样时 sync→strip 往返不吞用户内容",
    () => {
      fs.mkdirSync(path.join(kb, "KNOWBASE:END"));
      fs.writeFileSync(path.join(kb, "KNOWBASE:END", "a.md"), "x");
      fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
      fs.writeFileSync(claudeFile(), "# 偏好\n用中文回答\n");

      syncAgentConfig(kb, home);
      const written = fs.readFileSync(claudeFile(), "utf8");
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

  it("新增目录 → 区块随之更新，旧目录消失", () => {
    fs.mkdirSync(path.join(kb, "旧目录"));
    fs.writeFileSync(path.join(kb, "旧目录", "a.md"), "旧");
    syncAgentConfig(kb, home);

    fs.rmSync(path.join(kb, "旧目录"), { recursive: true });
    fs.mkdirSync(path.join(kb, "新目录"));
    fs.writeFileSync(path.join(kb, "新目录", "a.md"), "新");
    const changes = syncAgentConfig(kb, home);
    expect(changes.every((c) => c.action === "updated")).toBe(true);

    const content = fs.readFileSync(claudeFile(), "utf8");
    expect(content).toContain("新目录/（1）");
    expect(content).not.toContain("旧目录");
  });

  it("同目录内增删文件只改篇数，不新增行", () => {
    fs.mkdirSync(path.join(kb, "主题"));
    fs.writeFileSync(path.join(kb, "主题", "a.md"), "a");
    syncAgentConfig(kb, home);
    const before = fs.readFileSync(claudeFile(), "utf8");
    fs.writeFileSync(path.join(kb, "主题", "b.md"), "b");
    syncAgentConfig(kb, home);
    const after = fs.readFileSync(claudeFile(), "utf8");
    expect(after).toContain("主题/（2）");
    expect(after.split("\n").length).toBe(before.split("\n").length);
  });

  it("写入后不残留临时文件", () => {
    fs.writeFileSync(path.join(kb, "README.md"), "内容");
    syncAgentConfig(kb, home);
    const left = fs.readdirSync(path.join(home, ".claude"));
    expect(left.some((f) => f.includes("knowbase-tmp"))).toBe(false);
    expect(left).toContain("CLAUDE.md");
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
    fs.mkdirSync(path.join(kb, "角色定义"));
    fs.writeFileSync(path.join(kb, "角色定义", "职责.md"), "角色定义与职责");
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
    fs.mkdirSync(path.join(kb, "新条目"));
    fs.writeFileSync(path.join(kb, "新条目", "a.md"), "新条目内容");
    const refreshed = syncAgentConfig(kb, home, { onlyExisting: true });
    expect(refreshed.find((c) => c.name === "Claude Code")!.action).toBe("updated");
    expect(fs.readFileSync(claudeFile(), "utf8")).toContain("新条目");
  });
});
