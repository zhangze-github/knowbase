import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Logger } from "../src/config.js";
import {
  syncOnce,
  commitMessage,
  refreshAgentPrompts,
  refreshOrgSkills,
} from "../src/sync-engine.js";
import { syncAgentConfig, BLOCK_END } from "../src/agent-config.js";
import { PushGate, PROBE_INTERVAL_MS } from "../src/push-gate.js";
import {
  tmpDir,
  makeOrigin,
  cloneWorkdir,
  mkConfig,
  read,
  write,
  listConflictCopies,
  g,
  denyPush,
  allowPush,
} from "./helpers.js";

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

const deps = () => ({ logger, hostname: "hostX", now: () => new Date(2026, 6, 29, 12, 0, 0) });

describe("commitMessage", () => {
  it("列出 <=3 个文件名", () => {
    expect(commitMessage("h", ["a.md", "b.md"])).toBe("auto[h]: a.md, b.md");
  });
  it(">3 个文件计数", () => {
    expect(commitMessage("h", ["a", "b", "c", "d"])).toBe("auto[h]: 4 个文件变更");
  });
});

describe("同步引擎", () => {
  it("提交并推送本地新增，另一设备可同步到", () => {
    const A = path.join(root, "A");
    const B = path.join(root, "B");
    cloneWorkdir(bare, A);
    cloneWorkdir(bare, B);

    write(A, "note.md", "hello from A\n");
    const r = syncOnce(mkConfig(bare, A), deps());
    expect(r.committed).toBe(true);
    expect(r.pushed).toBe(true);
    expect(r.error).toBeUndefined();

    const rb = syncOnce(mkConfig(bare, B), deps());
    expect(rb.merged).toBe(true);
    expect(read(B, "note.md")).toContain("hello from A");
  });

  it("AC2: 同一 md 文件并发编辑 → union 保留双方内容", () => {
    const A = path.join(root, "A");
    const B = path.join(root, "B");
    cloneWorkdir(bare, A);
    cloneWorkdir(bare, B);

    // A 追加
    write(A, "README.md", "# KB\nLINE_FROM_A\n");
    expect(syncOnce(mkConfig(bare, A), deps()).pushed).toBe(true);

    // B 并发追加（基于旧版本），先本地提交，再 merge union
    write(B, "README.md", "# KB\nLINE_FROM_B\n");
    const rb = syncOnce(mkConfig(bare, B), deps());
    expect(rb.error).toBeUndefined();
    const bContent = read(B, "README.md");
    expect(bContent).toContain("LINE_FROM_A");
    expect(bContent).toContain("LINE_FROM_B");
    expect(rb.conflictCopies.length).toBe(0); // union 不产生冲突副本
    expect(rb.pushed).toBe(true);

    // A 再同步，也拿到双方内容
    const ra = syncOnce(mkConfig(bare, A), deps());
    expect(ra.merged).toBe(true);
    const aContent = read(A, "README.md");
    expect(aContent).toContain("LINE_FROM_A");
    expect(aContent).toContain("LINE_FROM_B");
  });

  it("AC2: 非 md 同一行冲突 → 生成冲突副本，双方内容均可找回，同步不中断", () => {
    const A = path.join(root, "A");
    const B = path.join(root, "B");
    cloneWorkdir(bare, A);
    cloneWorkdir(bare, B);

    // 先让两端都有 data.txt 基线
    write(A, "data.txt", "base\n");
    expect(syncOnce(mkConfig(bare, A), deps()).pushed).toBe(true);
    expect(syncOnce(mkConfig(bare, B), deps()).merged).toBe(true);

    // 并发改同一行
    write(A, "data.txt", "A-VERSION\n");
    expect(syncOnce(mkConfig(bare, A), deps()).pushed).toBe(true);

    write(B, "data.txt", "B-VERSION\n");
    const rb = syncOnce(mkConfig(bare, B), deps());

    expect(rb.error).toBeUndefined();
    expect(rb.merged).toBe(true);
    expect(rb.conflictCopies.length).toBe(1);
    expect(rb.pushed).toBe(true);

    // 原文件采用远端（A）版本
    expect(read(B, "data.txt")).toBe("A-VERSION\n");
    // 冲突副本保留本地（B）版本
    const copies = listConflictCopies(B);
    expect(copies.length).toBe(1);
    expect(copies[0]).toMatch(/data\.conflict-hostX-.*\.txt/);
    expect(read(B, copies[0])).toBe("B-VERSION\n");

    // A 同步后也能看到冲突副本与远端版本，双方内容均在
    const ra = syncOnce(mkConfig(bare, A), deps());
    expect(ra.merged).toBe(true);
    expect(read(A, "data.txt")).toBe("A-VERSION\n");
    expect(listConflictCopies(A).length).toBe(1);
    expect(read(A, listConflictCopies(A)[0])).toBe("B-VERSION\n");
  });

  it("删改冲突：本地删除 + 远端修改，容错不产生本地副本", () => {
    const A = path.join(root, "A");
    const B = path.join(root, "B");
    cloneWorkdir(bare, A);
    cloneWorkdir(bare, B);

    write(A, "data.txt", "base\n");
    syncOnce(mkConfig(bare, A), deps());
    syncOnce(mkConfig(bare, B), deps());

    // A 修改，B 删除
    write(A, "data.txt", "A-CHANGED\n");
    syncOnce(mkConfig(bare, A), deps());

    fs.rmSync(path.join(B, "data.txt"));
    const rb = syncOnce(mkConfig(bare, B), deps());
    expect(rb.error).toBeUndefined();
    expect(rb.merged).toBe(true);
    // 不应崩溃；合并完成
  });

  it("AC5: 暂停时不产生提交", () => {
    const A = path.join(root, "A");
    cloneWorkdir(bare, A);
    write(A, ".knowbase-pause", "");
    write(A, "wip.md", "半成品\n");

    const r = syncOnce(mkConfig(bare, A), deps());
    expect(r.paused).toBe(true);
    expect(r.committed).toBe(false);

    // 工作区仍为脏（未提交）
    const status = g(A, "status", "--porcelain");
    expect(status.stdout).toContain("wip.md");
  });

  it("AC3: 断网期间持续编辑，恢复后自动补同步，无数据丢失", () => {
    const A = path.join(root, "A");
    const B = path.join(root, "B");
    cloneWorkdir(bare, A);
    cloneWorkdir(bare, B);

    // 模拟断网：把 A 的 origin 指向不可达路径
    g(A, "remote", "set-url", "origin", path.join(root, "does-not-exist.git"));

    // 断网期间多次编辑 + 尝试同步
    write(A, "offline1.md", "edit-1\n");
    const r1 = syncOnce(mkConfig(bare, A), deps());
    expect(r1.committed).toBe(true); // 本地提交成功
    expect(r1.pushed).toBe(false);
    expect(r1.error).toBeDefined(); // fetch 失败

    write(A, "offline2.md", "edit-2\n");
    const r2 = syncOnce(mkConfig(bare, A), deps());
    expect(r2.committed).toBe(true);
    expect(r2.error).toBeDefined();

    // 恢复网络
    g(A, "remote", "set-url", "origin", bare);
    const r3 = syncOnce(mkConfig(bare, A), deps());
    expect(r3.error).toBeUndefined();
    expect(r3.pushed).toBe(true);

    // B 同步后应看到断网期间的所有编辑
    syncOnce(mkConfig(bare, B), deps());
    expect(read(B, "offline1.md")).toContain("edit-1");
    expect(read(B, "offline2.md")).toContain("edit-2");
  });

  it("push 被拒后下一周期先合并再推，天然收敛", () => {
    const A = path.join(root, "A");
    const B = path.join(root, "B");
    cloneWorkdir(bare, A);
    cloneWorkdir(bare, B);

    // B 先推送一个改动，使 A 落后
    write(B, "b.md", "from B\n");
    expect(syncOnce(mkConfig(bare, B), deps()).pushed).toBe(true);

    // A 本地也有改动，但 A 尚未 fetch → 直接构造并发：先让 A 提交，再手动使远端领先
    // 通过：A 编辑并同步（此时会 fetch 到 B 的改动并 merge，再 push）——应收敛
    write(A, "a.md", "from A\n");
    const ra = syncOnce(mkConfig(bare, A), deps());
    expect(ra.error).toBeUndefined();
    expect(ra.pushed).toBe(true);

    // 最终远端两文件都在
    syncOnce(mkConfig(bare, B), deps());
    expect(read(B, "a.md")).toContain("from A");
    expect(read(A, "b.md")).toContain("from B");
  });
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
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n- 新条目\n");
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
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n- 触发一次真实写入\n");

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

describe("push 无权限熔断", () => {
  /** 造一个「本地有改动待推、远端拒绝写入」的场景。 */
  function setup(): { kb: string; cfg: ReturnType<typeof mkConfig> } {
    const kb = path.join(root, "kb");
    cloneWorkdir(bare, kb);
    denyPush(bare);
    write(kb, "a.md", "hello\n");
    return { kb, cfg: mkConfig(bare, kb) };
  }

  const at = (ms: number) => ({
    logger,
    hostname: "hostX",
    now: () => new Date(ms),
  });

  const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);

  it("判定为 denied 而不是并发竞争", () => {
    const { cfg } = setup();
    const gate = new PushGate();
    const r = syncOnce(cfg, { ...at(T0), pushGate: gate });
    expect(r.pushDenied).toBe(true);
    expect(r.pushRejected).toBe(false);
    expect(r.pushed).toBe(false);
    expect(gate.blocked).toBe(true);
  });

  it("熔断后连跑多轮只尝试一次 push", () => {
    const { kb, cfg } = setup();
    const gate = new PushGate();
    syncOnce(cfg, { ...at(T0), pushGate: gate });

    // PushGate.shouldAttempt 在到点（>=）时会真的放行一次探测（Task 2 规格明确如此）。
    // 步长必须严格小于 PROBE_INTERVAL_MS / 轮数，否则某一轮会撞上窗口边界、触发一次
    // 真实（仍被拒绝的）push 尝试，与本用例「连跑多轮全程只跳过」的断言矛盾。
    // 从常量推导轮数，而不是像 50_000 这样硬编码一个凑出来的步长——
    // 这样 PROBE_INTERVAL_MS 以后调整时，这条用例不会静默地再次撞上边界。
    const CYCLE_MS = 60_000; // 与 DEFAULT_INTERVAL=60s 对齐，是真实周期长度
    const rounds = PROBE_INTERVAL_MS / CYCLE_MS - 1; // 4 轮，构造上保证严格落在窗口内
    for (let i = 1; i <= rounds; i++) {
      write(kb, `b${i}.md`, "x\n");
      const r = syncOnce(cfg, { ...at(T0 + i * CYCLE_MS), pushGate: gate });
      expect(r.pushSkipped).toBe(true);
      expect(r.pushed).toBe(false);
      // 关键：熔断只掐 push，本地提交必须照常发生
      expect(r.committed).toBe(true);
    }
  });

  it("熔断期间日志里该错误只出现一次", () => {
    const { kb, cfg } = setup();
    const gate = new PushGate();
    syncOnce(cfg, { ...at(T0), pushGate: gate });
    // 步长刻意保持 60_000（不要为了跟上一条用例「看起来一致」改成别的值）：
    // 第 5 轮 T0+300_000 恰好等于 PROBE_INTERVAL_MS，即探测窗口到点，PushGate 会真的
    // 再放行一次探测；该次探测仍被拒绝（denyPush 全程未摘），record() 返回 "unchanged"，
    // 因此不应追加第二条日志。这是全套测试里唯一覆盖「重复 denied 探测不追加日志」
    // 这条防回归路径的用例，步长不要改。
    for (let i = 1; i <= 5; i++) {
      write(kb, `b${i}.md`, "x\n");
      syncOnce(cfg, { ...at(T0 + i * 60_000), pushGate: gate });
    }
    const log = fs.readFileSync(logger.path(), "utf8");
    const hits = log.split("\n").filter((l) => l.includes("push 无权限"));
    expect(hits).toHaveLength(1);
  });

  it("窗口到点会再探测一次", () => {
    const { cfg } = setup();
    const gate = new PushGate();
    syncOnce(cfg, { ...at(T0), pushGate: gate });
    const r = syncOnce(cfg, { ...at(T0 + PROBE_INTERVAL_MS), pushGate: gate });
    expect(r.pushSkipped).toBe(false);
    expect(r.pushDenied).toBe(true);
  });

  it("熔断期间仍能合并远端改动（只读模式可用）", () => {
    const { kb, cfg } = setup();
    const gate = new PushGate();
    syncOnce(cfg, { ...at(T0), pushGate: gate });

    // 另一台设备推了内容到远端（绕过钩子：直接改 bare 的另一个 clone 再 push 会被拦，
    // 所以先摘钩子推完再装回去）
    allowPush(bare);
    const other = path.join(root, "other");
    cloneWorkdir(bare, other);
    write(other, "from-team.md", "team\n");
    g(other, "add", "-A");
    g(other, "commit", "-m", "team change");
    g(other, "push", "origin", "HEAD:main");
    denyPush(bare);

    const r = syncOnce(cfg, { ...at(T0 + 60_000), pushGate: gate });
    expect(r.merged).toBe(true);
    expect(r.pushSkipped).toBe(true);
    expect(r.pushed).toBe(false);
    expect(gate.blocked).toBe(true);
    expect(read(kb, "from-team.md")).toBe("team\n");
    // 本地待推的改动（setup 里写的 a.md）在只读模式的 merge 之后仍要安全存活，
    // 不能因为熔断跳过 push 就丢在本地或被合并覆盖掉。
    expect(read(kb, "a.md")).toBe("hello\n");
  });

  it("权限恢复后自动继续推送并写一条恢复日志", () => {
    const { cfg } = setup();
    const gate = new PushGate();
    syncOnce(cfg, { ...at(T0), pushGate: gate });
    expect(gate.blocked).toBe(true);

    allowPush(bare);
    const r = syncOnce(cfg, { ...at(T0 + PROBE_INTERVAL_MS), pushGate: gate });
    expect(r.pushed).toBe(true);
    expect(gate.blocked).toBe(false);
    expect(fs.readFileSync(logger.path(), "utf8")).toContain("push 权限已恢复");
  });

  it("不传 pushGate 时不熔断（前台 knowbase sync 的行为）", () => {
    const { kb, cfg } = setup();
    const r1 = syncOnce(cfg, at(T0));
    expect(r1.pushDenied).toBe(true);
    write(kb, "c.md", "x\n");
    const r2 = syncOnce(cfg, at(T0 + 1000));
    expect(r2.pushSkipped).toBe(false);
    expect(r2.pushDenied).toBe(true);
    // 没有熔断器就没有「翻转」这回事，flip 恒为 "unchanged"；
    // src/sync-engine.ts 里 `flip === "blocked" || !gate` 的 `|| !gate` 分支
    // 就是为了在这种情况下仍然把拒绝原因写进日志——这里必须断言到，
    // 否则删掉 `|| !gate` 全套测试也会照样全绿，等于这个分支零覆盖。
    const log = fs.readFileSync(logger.path(), "utf8");
    expect(log).toContain("push 无权限");
  });
});
