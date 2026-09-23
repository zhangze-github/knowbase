import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Logger } from "../src/config.js";
import { refreshAgentPrompts, refreshOrgSkills } from "../src/sync-engine.js";
import { syncAgentConfig, BLOCK_END } from "../src/agent-config.js";
import { tmpDir, makeOrigin, cloneWorkdir, mkConfig, read, write } from "./helpers.js";

/**
 * 让 syncSkills 按需抛一次错，用来验证 refreshOrgSkills 的失败隔离。
 *
 * 必须用模块 mock：syncSkills 内部处处 catch（readSkillSources / readExistingTargets
 * / cleanTmpDirs / 每个 skill 的落盘都各自吞异常），构造不出让它真的抛出来的场景，
 * 所以「知识库目录不存在也不抛错」那种写法是恒真断言——把 refreshOrgSkills 的
 * try/catch 整个删掉照样全绿。默认透传真实实现，只在置了标志的那条用例里抛。
 */
const skillsMock = vi.hoisted(() => ({ throwOnce: false }));
vi.mock("../src/skills-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/skills-sync.js")>();
  return {
    ...actual,
    syncSkills: (...args: Parameters<typeof actual.syncSkills>) => {
      if (skillsMock.throwOnce) {
        skillsMock.throwOnce = false;
        throw new Error("模拟 syncSkills 抛错");
      }
      return actual.syncSkills(...args);
    },
  };
});

let root: string;
let bare: string;
let logger: Logger;

beforeEach(() => {
  root = tmpDir("engine");
  bare = makeOrigin(root);
  logger = new Logger(path.join(root, "test.log"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});


describe("refreshAgentPrompts", () => {
  let base: string;
  let home: string;
  let kb: string;
  let logFile: string;
  let lg: Logger;
  const claude = () => path.join(home, ".claude", "CLAUDE.md");
  const cfg = (agentConfig?: boolean) => ({
    repoUrl: "x",
    dir: kb,
    interval: 60,
    branch: "main",
    agentConfig,
  });

  beforeEach(() => {
    base = tmpDir("refresh");
    home = path.join(base, "home");
    kb = path.join(base, "kb");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(kb, { recursive: true });
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n");
    logFile = path.join(base, "log");
    lg = new Logger(logFile);
  });
  afterEach(() => {
    // 兜底还原 spy：下面的 renameSync mock 在断言失败时不会走到内联 restore，
    // 之后追加的用例会继承一个必然抛错的 renameSync。
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("agentConfig:false → 不写任何提示词文件", () => {
    refreshAgentPrompts(cfg(false), lg, home);
    expect(fs.existsSync(claude())).toBe(false);
  });

  it("只刷新已存在的区块，从不创建（用户删掉区块即视为退出）", () => {
    // 区块不存在 → 守护进程不得创建。覆盖两种退出方式：
    // 老版本 --no-agent-config 接入（配置无该键、被当成开启）、用户手动删区块。
    refreshAgentPrompts(cfg(true), lg, home);
    expect(fs.existsSync(claude())).toBe(false);

    fs.mkdirSync(path.dirname(claude()), { recursive: true });
    fs.writeFileSync(claude(), "# 偏好\n我不要 knowbase 区块\n");
    refreshAgentPrompts(cfg(true), lg, home);
    expect(fs.readFileSync(claude(), "utf8")).not.toContain("KNOWBASE:START");

    // init 建好区块之后，刷新照常生效
    syncAgentConfig(kb, home);
    fs.writeFileSync(path.join(kb, "新条目.md"), "内容");
    refreshAgentPrompts(cfg(true), lg, home);
    expect(fs.readFileSync(claude(), "utf8")).toContain("新条目");
  });

  it("区块结束标记缺失 → 记一行说明原因的日志，不动文件", () => {
    syncAgentConfig(kb, home);
    const broken = fs
      .readFileSync(claude(), "utf8")
      .replace(BLOCK_END, "")
      .concat("\n# 我后面的重要内容\n别删我\n");
    fs.writeFileSync(claude(), broken);

    refreshAgentPrompts(cfg(true), lg, home);
    expect(fs.readFileSync(claude(), "utf8")).toBe(broken);
    const log = fs.readFileSync(logFile, "utf8");
    expect(log).toContain("结束标记缺失");
    expect(log).toContain("已跳过");
  });

  it("写入失败时吞掉异常并记日志，不向外抛", () => {
    // 先让区块存在（否则 onlyExisting 会直接跳过、根本走不到写盘），再让
    // rename 必然失败，检验异常被吞在 refreshAgentPrompts 内部。
    syncAgentConfig(kb, home);
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("模拟 rename 失败");
    });
    // 新增文件让目录树内容真正变化，从而触发一次真实写入
    // （单纯改写已有文件内容不影响树，不会产生新的写盘）
    fs.writeFileSync(path.join(kb, "触发一次真实写入.md"), "内容");

    expect(() => refreshAgentPrompts(cfg(true), lg, home)).not.toThrow();
    spy.mockRestore();
    expect(fs.readFileSync(logFile, "utf8")).toContain("刷新 agent 提示词失败");
  });
});

describe("refreshOrgSkills", () => {
  it("周期末分发团队 skills", () => {
    const root = tmpDir("engine-skills");
    const bare = makeOrigin(root);
    const dir = path.join(root, "kb");
    cloneWorkdir(bare, dir);
    const home = path.join(root, "home");
    write(dir, "skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n\n步骤\n");

    refreshOrgSkills({ ...mkConfig(bare, dir) }, new Logger(path.join(root, "log")), home);

    const md = path.join(home, ".claude", "skills", "org-demo", "SKILL.md");
    expect(fs.readFileSync(md, "utf8")).toContain("name: org-demo");
  });

  it("skills: false → 不写入 ~/.claude/skills", () => {
    const root = tmpDir("engine-skills-off");
    const bare = makeOrigin(root);
    const dir = path.join(root, "kb");
    cloneWorkdir(bare, dir);
    const home = path.join(root, "home");
    write(dir, "skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n\n步骤\n");

    refreshOrgSkills(
      { ...mkConfig(bare, dir), skills: false },
      new Logger(path.join(root, "log")),
      home
    );

    expect(fs.existsSync(path.join(home, ".claude", "skills"))).toBe(false);
  });

  it("装了 Codex 时同一 skill 也分发到 ~/.codex/skills", () => {
    const root = tmpDir("engine-skills-codex");
    const bare = makeOrigin(root);
    const dir = path.join(root, "kb");
    cloneWorkdir(bare, dir);
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    // 光有目录不够（knowbase 自己也会造出这个目录），得放一个真实 Codex
    // 才会有的文件，skillTargets 才会判定「装了 Codex」
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
    write(dir, "skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n正文\n");

    refreshOrgSkills({ ...mkConfig(bare, dir) }, new Logger(path.join(root, "log")), home);

    for (const base of [".claude", ".codex"]) {
      const md = path.join(home, base, "skills", "org-demo", "SKILL.md");
      expect(fs.readFileSync(md, "utf8")).toContain("name: org-demo");
    }
  });

  it("syncSkills 抛错时吞掉异常并记日志，不向外抛（失败隔离）", () => {
    // 照 refreshAgentPrompts 那条「写入失败时吞掉异常并记日志」的写法：真造一次
    // 失败并断言日志。只断言「不抛错」是恒真的——见文件头 skillsMock 的注释。
    const root = tmpDir("engine-skills-err");
    const logFile = path.join(root, "log");
    skillsMock.throwOnce = true;
    expect(() =>
      refreshOrgSkills(
        { ...mkConfig("u", path.join(root, "nope")) },
        new Logger(logFile),
        path.join(root, "home")
      )
    ).not.toThrow();
    expect(skillsMock.throwOnce).toBe(false); // 确实被调用到了
    expect(fs.readFileSync(logFile, "utf8")).toContain("分发团队 skills 失败");
  });
});
