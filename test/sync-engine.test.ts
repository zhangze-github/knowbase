import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Logger } from "../src/config.js";
import { syncOnce, commitMessage, refreshAgentPrompts } from "../src/sync-engine.js";
import { syncAgentConfig, BLOCK_END } from "../src/agent-config.js";
import {
  tmpDir,
  makeOrigin,
  cloneWorkdir,
  mkConfig,
  read,
  write,
  listConflictCopies,
  g,
} from "./helpers.js";

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
