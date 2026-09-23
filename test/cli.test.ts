import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir, makeOrigin, makeBareOrigin, makeMirrorOrigin, g } from "./helpers.js";

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "cli.js"
);

let root: string;
let home: string;
let bare: string;

function knowbase(args: string[], extraEnv: Record<string, string> = {}) {
  const res = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      KNOWBASE_SKIP_AUTOSTART: "1",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      ...extraEnv,
    },
  });
  return { code: res.status ?? 1, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

/** 解析真实 git 可执行文件的绝对路径，供 shim 脚本 exec 转发用（不能在 shim 里再走 PATH，否则递归）。 */
function resolveRealGit(): string {
  const r = spawnSync("which", ["git"], { encoding: "utf8" });
  const p = r.stdout.trim();
  if (!p) throw new Error("找不到真实 git，无法搭建 shim");
  return p;
}

/**
 * 搭一个「git shim」：命中 `push --dry-run` 时打印 GitLab 无 push 权限的真实
 * 文案并 exit 1，其余命令原样转发给真实 git。
 *
 * 为什么不能像别处那样用本地 bare 仓库 + pre-receive 钩子模拟：`--dry-run`
 * 在协议层面从不发送 ref-update 命令（哪怕远端会拒绝），receive-pack 端的
 * pre-receive 钩子只在收到真实命令时才执行，本地 bare 仓库的传输层又没有
 * GitHub/GitLab 那种「协商之前先鉴权」的中间层，导致钩子永远不会被触发——
 * 模拟不出「--dry-run 也会撞上权限拒绝」这个真实远端才有的行为。用 shim
 * 直接在更外层伪造服务端的拒绝响应，就不依赖本地 bare 仓库有没有鉴权层了。
 *
 * 拦截条件遍历整个 "$@" 找 `--dry-run`，不依赖它出现在固定的第几个位置——
 * 真实（非 dry-run）push 永远不会带这个 flag，不会被误伤；这样即使
 * src/git.ts 里 pushDryRun 调整了参数顺序，shim 也不会静默失配。
 */
function makeDenyDryRunShim(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const realGit = resolveRealGit();
  const shim = path.join(dir, "git");
  fs.writeFileSync(
    shim,
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    echo "remote: You are not allowed to push code to this project." >&2
    echo "fatal: unable to access 'origin': The requested URL returned error: 403" >&2
    exit 1
  fi
done
exec "${realGit}" "$@"
`
  );
  fs.chmodSync(shim, 0o755);
  return dir;
}

/**
 * 往 bare 远端推一个合法 skill，让后续 init 克隆时自然带下来。
 * label 只用于隔离每个用例的临时 clone 目录。
 */
function seedRemoteSkill(name: string, label: string): void {
  const seed = path.join(root, `seed-${label}`);
  g(root, "clone", bare, seed);
  const dir = path.join(seed, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: 演示\n---\n\n步骤一\n`
  );
  g(seed, "add", "-A");
  g(seed, "commit", "-m", `add skill ${name}`);
  g(seed, "push", "origin", "HEAD:main");
}

beforeEach(() => {
  root = tmpDir("cli");
  home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  bare = makeMirrorOrigin(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("CLI 端到端（真实运行 dist/cli.js）", () => {
  it("--version / --help", () => {
    const v = knowbase(["--version"]);
    expect(v.code).toBe(0);
    expect(v.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);

    const h = knowbase(["--help"]);
    expect(h.code).toBe(0);
    expect(h.out).toContain("init");
    expect(h.out).toContain("status");
    expect(h.out).toContain("uninstall");
    // daemon 为隐藏命令，不应出现在帮助中
    expect(h.out).not.toContain("daemon");
    // 已删除的命令不得残留在帮助里
    expect(h.out).not.toContain("pause");
    expect(h.out).not.toContain("resume");
  });

  it("帮助文案不描述已废弃的经典模式行为", () => {
    // 1.0.0 删功能时漏改了 .description() 字符串，帮助里仍写着「双向同步」「种入规则」，
    // 而这些行为已经不存在——纯文案不会被任何行为测试抓到，只能这样锁住。
    const h = knowbase(["--help"]);
    expect(h.out).not.toContain("双向同步");
    expect(h.out).not.toContain("种入规则");
    expect(h.out).not.toContain("冲突");

    const ih = knowbase(["init", "--help"]);
    expect(ih.out).not.toContain("种入规则");
    expect(ih.out).toContain("只读");
  });

  it("init → 写配置、跳过自启、不产生新 commit", () => {
    const kb = path.join(root, "kb");
    const r = knowbase(["init", bare, "--dir", kb]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("接入完成");

    // 配置文件
    const cfgPath = path.join(home, ".config", "knowbase", "config.json");
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(cfg.repoUrl).toBe(bare);
    expect(cfg.dir).toBe(kb);

    // 1.0.0：不再种入 union / 忽略规则（镜像仓库的规则由 exporter 侧维护）
    expect(fs.existsSync(path.join(kb, ".gitattributes"))).toBe(false);

    // 默认自动配置 Claude Code / Codex 全局提示词
    const claude = path.join(home, ".claude", "CLAUDE.md");
    const codex = path.join(home, ".codex", "AGENTS.md");
    expect(fs.readFileSync(claude, "utf8")).toContain(kb);
    expect(fs.readFileSync(codex, "utf8")).toContain(kb);
    expect(r.out).toContain("全局提示词");
  });

  it("init 拒绝非镜像仓库：明确报错、不 clone 成可用状态", () => {
    // 1.0.0 废弃经典模式。同步手段是 reset --hard，把可写仓库当镜像接入
    // 等于给数据丢失开口子——必须当场硬失败，而不是降级接入。
    const classicBare = makeOrigin(root);
    const kb = path.join(root, "kb-classic");
    const r = knowbase(["init", classicBare, "--dir", kb]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain(".knowbase-mirror.json");
    expect(fs.existsSync(path.join(home, ".config", "knowbase", "config.json"))).toBe(false);
  });

  it("init 对镜像仓库只读接入：跳过种入规则、不产生新 commit、打印镜像说明", () => {
    const mirrorBare = makeMirrorOrigin(root);
    const kb = path.join(root, "kb-mirror");
    const r = knowbase(["init", mirrorBare, "--dir", kb]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("只读镜像");
    expect(r.out).toContain("lark-doc");

    // 不产生新 commit：本地历史仍只有 exporter 侧的那一次 "mirror: init"，
    // 经典路径本会在此追加一条「种入 union 规则」的 commit。
    const log = g(kb, "log", "--oneline");
    const lines = log.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(log.stdout).toContain("mirror: init");

    // 未种入 union / 忽略规则
    expect(fs.existsSync(path.join(kb, ".gitattributes"))).toBe(false);
  });

  it("init 保留 Claude 已有全局偏好，仅追加托管区块", () => {
    const kb = path.join(root, "kb");
    const claude = path.join(home, ".claude", "CLAUDE.md");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, "# 全局偏好\n始终用中文回答。\n");

    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    const content = fs.readFileSync(claude, "utf8");
    expect(content).toContain("始终用中文回答");
    expect(content).toContain("KNOWBASE:START");
  });

  it("--no-agent-config 跳过全局提示词写入", () => {
    const kb = path.join(root, "kb");
    const r = knowbase(["init", bare, "--dir", kb, "--no-agent-config"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("跳过");
    expect(fs.existsSync(path.join(home, ".claude", "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex", "AGENTS.md"))).toBe(false);
  });

  it("agentConfig 开关持久化进 config.json", () => {
    const kb = path.join(root, "kb");
    const cfgPath = path.join(home, ".config", "knowbase", "config.json");

    expect(knowbase(["init", bare, "--dir", kb, "--no-agent-config"]).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).agentConfig).toBe(false);

    // 默认 init（复用同目录）→ 开关回到 true
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).agentConfig).toBe(true);
  });

  it("init 默认分发团队 skills 并持久化 skills 开关", () => {
    const kb = path.join(root, "kb");
    const cfgPath = path.join(home, ".config", "knowbase", "config.json");
    seedRemoteSkill("demo", "init-skills");

    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).skills).toBe(true);

    const dest = path.join(home, ".claude", "skills", "org-demo");
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toContain("name: org-demo");
    expect(fs.existsSync(path.join(dest, ".knowbase.json"))).toBe(true);
  });

  it("没装 Codex 的机器上 init 不残留 ~/.codex/skills（knowbase 自建 AGENTS.md 不算装了 Codex）", () => {
    // 回归用例：init 会自动写 ~/.codex/AGENTS.md（全局提示词），顺带把 ~/.codex
    // 目录建出来。这不代表这台机器装了 Codex，skillTargets 不该把它当成
    // Codex 目标——分发到 ~/.codex/skills 会造成没装 Codex 的机器上凭空多出
    // 一个目录，且永远不会被任何东西清理。
    const kb = path.join(root, "kb");
    seedRemoteSkill("demo", "init-no-codex");

    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(fs.existsSync(path.join(home, ".codex", "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".codex", "skills"))).toBe(false);
  });

  it("--no-skills 跳过分发并持久化为 false", () => {
    const kb = path.join(root, "kb");
    const cfgPath = path.join(home, ".config", "knowbase", "config.json");
    seedRemoteSkill("demo", "no-skills");

    expect(knowbase(["init", bare, "--dir", kb, "--no-skills"]).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).skills).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude", "skills"))).toBe(false);

    // 默认 init（复用同目录）→ 开关回到 true 且补上分发
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).skills).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "org-demo"))).toBe(true);
  });



  it("status 展示 CLI 版本（已接入与未接入都要有）", () => {
    const pkgVersion = (
      JSON.parse(
        fs.readFileSync(
          path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
          "utf8"
        )
      ) as { version: string }
    ).version;

    // 未接入：early return 之前也要能看到版本
    const before = knowbase(["status"]);
    expect(before.out).toContain(`CLI 版本：  ${pkgVersion}`);

    // 已接入
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb, "--no-agent-config"]).code).toBe(0);
    const after = knowbase(["status"]);
    expect(after.out).toContain(`CLI 版本：  ${pkgVersion}`);
  });

  it("status 反映：守护进程未运行（AC4）", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    const st = knowbase(["status"]);
    expect(st.out).toContain("守护进程");
    expect(st.out).toContain("未运行");
    expect(st.code).not.toBe(0);
  });

  it("status 报告目录树注入状态：暂无 / 已注入 / 已关闭", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    // 清空 clone 下来的种子文件（镜像种子带 docs/guide.md），验证「知识库暂无文件」
    // 这个 day one 的正常状态，不算异常。镜像目录是只读的，先解锁再删。
    fs.chmodSync(path.join(kb, "docs", "guide.md"), 0o644);
    fs.rmSync(path.join(kb, "docs"), { recursive: true, force: true });
    const missing = knowbase(["status"]);
    expect(missing.out).toContain("agent 提示词");
    expect(missing.out).toContain("知识库暂无文件");
    // 「需要注意」汇总里不得出现文件缺失（否则每个新团队的 status 永久非零退出）
    const attention = missing.out.split("需要注意：")[1] ?? "";
    expect(attention).not.toContain("知识库暂无文件");

    // 有文件 → 报告文件数与体积
    fs.writeFileSync(path.join(kb, "笔记.md"), "# 笔记\n- 角色/\n");
    const injected = knowbase(["status"]);
    expect(injected.out).toMatch(/agent 提示词：已注入目录树（1 个文件，[\d.]+KB）/);

    // 关闭开关 → 报告已关闭
    expect(knowbase(["init", bare, "--dir", kb, "--no-agent-config"]).code).toBe(0);
    expect(knowbase(["status"]).out).toContain("agent 提示词：已关闭");
  });

  it("status 报告团队 skills：暂无 / 已分发 / 已关闭", () => {
    const kb = path.join(root, "kb");

    // 知识库没有 skills/ 目录
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    const dayOne = knowbase(["status"]);
    expect(dayOne.out).toContain("知识库暂无 skills/ 目录");
    // 「需要注意」汇总里不得出现 skill 相关异常（否则每个还没建 skills/ 的新团队
    // status 永久非零退出、把拿退出码做监控的包装脚本永久标红）。贴着代码实际
    // 能 push 的文案「团队 skill <name> 未分发」断言——匹配 "skills" 判别力不够，
    // 那个异常文案是单数，压根撞不上。
    const attention = dayOne.out.split("需要注意：")[1] ?? "";
    expect(attention).not.toContain("团队 skill");

    // 关闭
    expect(knowbase(["init", bare, "--dir", kb, "--no-skills"]).code).toBe(0);
    expect(knowbase(["status"]).out).toContain("--no-skills");
  });

  it("status：唯一的 skill 源坏了（缺 description）且盘上无副本 → 报跳过警告、不误判 day one、非零退出", () => {
    // 回归：day-one 判定原来只看 sources.length === 0，坏源同样会让
    // sources 变空，与「团队还没建 skills/」这个真正的 day-one 状态无法区分——
    // 这里构造的是「skills/ 目录确实存在，只是唯一的 skill 因缺 description
    // 校验没通过」，不该走「暂无 skills/ 目录」这条分支，且必须报出跳过警告、
    // 非零退出（与基线版本一致）。
    const kb = path.join(root, "kb");
    const seed = path.join(root, "seed-status-invalid");
    g(root, "clone", bare, seed);
    fs.mkdirSync(path.join(seed, "skills", "demo"), { recursive: true });
    fs.writeFileSync(
      path.join(seed, "skills", "demo", "SKILL.md"),
      "---\nname: demo\n---\n\n缺 description\n"
    );
    g(seed, "add", "-A");
    g(seed, "commit", "-m", "add invalid skill demo");
    g(seed, "push", "origin", "HEAD:main");

    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    const s = knowbase(["status"]);
    expect(s.out).toContain("⚠ 跳过 demo：");
    expect(s.out).not.toContain("暂无 skills/ 目录");
    expect(s.code).not.toBe(0);
  });

  it("status 统计已分发的团队 skills 数量", () => {
    const kb = path.join(root, "kb");
    seedRemoteSkill("demo", "status-count");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(knowbase(["status"]).out).toContain("已分发 1 个");
  });

  it("同名目录非托管时 status 提示未覆盖、计入需要注意并非零退出", () => {
    const kb = path.join(root, "kb");
    seedRemoteSkill("demo", "status-foreign");
    // 先手工占位 org-demo（无 .knowbase.json），模拟成员自己写过同名 skill
    const own = path.join(home, ".claude", "skills", "org-demo");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, "SKILL.md"), "---\nname: org-demo\n---\n我自己写的\n");

    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    const s = knowbase(["status"]);
    expect(s.out).toContain("未覆盖");
    expect(s.code).toBe(1);
    // 内容必须原样保留
    expect(fs.readFileSync(path.join(own, "SKILL.md"), "utf8")).toContain("我自己写的");
  });

  it("托管副本被删掉后 status 报「已分发 0 个」，不把待装的算成已分发", () => {
    // status 是只读命令，报告的是**当前**状态：created 的含义是「副本还不在盘上、
    // 下一次分发才会装」，算进「已分发」就是虚报。待装的那些由「源 N 个」的差额体现。
    const kb = path.join(root, "kb");
    seedRemoteSkill("demo", "status-pending");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    const dest = path.join(home, ".claude", "skills", "org-demo");
    expect(knowbase(["status"]).out).toContain("已分发 1 个");

    // 副本被删掉（守护进程下个周期会重新装上，但此刻盘上确实没有）
    fs.rmSync(dest, { recursive: true });
    const s = knowbase(["status"]);
    expect(s.out).toContain("已分发 0 个（org-*），源 1 个");
    expect(s.out).not.toContain("已分发 1 个");
  });

  it("知识库里删掉 skill 后重跑 init：撤下副本这件事必须打印出来", () => {
    // 静默删掉一个副本一个字不打印，用户只会发现 skill 莫名消失
    // （agent-config 那边连 unchanged 都会打印「已是最新」）。
    const kb = path.join(root, "kb");
    seedRemoteSkill("demo", "init-removed");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "org-demo"))).toBe(true);

    fs.rmSync(path.join(kb, "skills", "demo"), { recursive: true });
    const again = knowbase(["init", bare, "--dir", kb]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("已撤下");
    expect(again.out).toContain("org-demo");
    expect(fs.existsSync(path.join(home, ".claude", "skills", "org-demo"))).toBe(false);
  });

  it("悬空软链占位 org-demo 时 status 也报未覆盖并非零退出", () => {
    // status 曾用 fs.existsSync 自己重算一遍 foreign，而 existsSync **跟随**软链、
    // 分发侧的 readExistingTargets **不跟随**：一条悬空软链会让 syncSkills 永久
    // 判 foreign（分发被彻底阻塞），而 status 打印「已分发 0 个」、不计入需要注意。
    // status 存在的唯一理由就是给这套静默机制提供可见性，判定分叉等于没有。
    const kb = path.join(root, "kb");
    seedRemoteSkill("demo", "status-dangling");
    const skillsHome = path.join(home, ".claude", "skills");
    fs.mkdirSync(skillsHome, { recursive: true });
    fs.symlinkSync(path.join(root, "nowhere"), path.join(skillsHome, "org-demo"));

    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    const s = knowbase(["status"]);
    expect(s.out).toContain("未覆盖");
    expect(s.code).toBe(1);
    // 无标记一律不碰：软链原样留着
    expect(fs.lstatSync(path.join(skillsHome, "org-demo")).isSymbolicLink()).toBe(true);
  });

  it("uninstall 移除托管 skills 副本，保留用户自己的 skill", () => {
    const kb = path.join(root, "kb");
    seedRemoteSkill("demo", "uninst-skill");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "org-demo"))).toBe(true);

    const mine = path.join(home, ".claude", "skills", "my-own");
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "SKILL.md"), "---\nname: my-own\n---\n私人\n");

    expect(knowbase(["uninstall"]).code).toBe(0);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "org-demo"))).toBe(false);
    expect(fs.readFileSync(path.join(mine, "SKILL.md"), "utf8")).toContain("私人");
  });

  it("uninstall 删不掉副本时明确报出来，不谎报成功", () => {
    // 删除失败而 uninstall 一个字都不打印，是最糟的组合：配置已删、status 也不再
    // 工作，这份仍被 Claude Code 加载的团队 skill 再没有任何入口能被发现。
    const kb = path.join(root, "kb");
    seedRemoteSkill("demo", "uninst-fail");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    const skillsHome = path.join(home, ".claude", "skills");
    expect(fs.existsSync(path.join(skillsHome, "org-demo"))).toBe(true);

    fs.chmodSync(skillsHome, 0o500); // r-x：目录内条目不可删
    try {
      const u = knowbase(["uninstall"]);
      expect(u.out).toContain("未能移除");
      expect(u.out).toContain("org-demo");
      expect(fs.existsSync(path.join(skillsHome, "org-demo"))).toBe(true);
    } finally {
      // 改回可写，否则 afterEach 清理临时目录会失败
      fs.chmodSync(skillsHome, 0o755);
    }
  });

  it("空知识库 → 区块回退文案与 status 口径一致", () => {
    const kb = path.join(root, "kb");
    const claude = path.join(home, ".claude", "CLAUDE.md");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    // 清空 clone 下来的种子文件，模拟「知识库确实没有文件」
    fs.chmodSync(path.join(kb, "docs", "guide.md"), 0o644);
    fs.rmSync(path.join(kb, "docs"), { recursive: true, force: true });
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    // 区块：走回退文案，不出现空的目录树小节
    const content = fs.readFileSync(claude, "utf8");
    expect(content).not.toContain("### 知识库目录树");
    expect(content).toContain("暂无");
    // status：报告「知识库暂无文件」，不报「已注入 0.0KB」
    const st = knowbase(["status"]);
    expect(st.out).toContain("知识库暂无文件");
    expect(st.out).not.toContain("已注入目录树");
  });

  it.skipIf(process.platform === "win32")(
    "文件名含 KNOWBASE:END 字样时 init→uninstall 全链路不吞用户内容",
    () => {
      const kb = path.join(root, "kb");
      const claude = path.join(home, ".claude", "CLAUDE.md");
      fs.mkdirSync(path.dirname(claude), { recursive: true });
      fs.writeFileSync(claude, "# 全局偏好\n始终用中文回答。\n");

      expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
      // 目录树里出现区块结束标记字样的文件名（例如某篇文档标题恰好如此）
      fs.writeFileSync(path.join(kb, "KNOWBASE:END.md"), "内容");
      expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

      const withBlock = fs.readFileSync(claude, "utf8");
      expect(withBlock).toContain("KNOWBASE_END"); // 已中和
      expect(withBlock.split("KNOWBASE:END").length - 1).toBe(1); // 真结束标记只有一个

      expect(knowbase(["uninstall"]).code).toBe(0);
      const after = fs.readFileSync(claude, "utf8");
      expect(after).toContain("始终用中文回答");
      expect(after).not.toContain("KNOWBASE");
      expect(after).not.toContain("KNOWBASE:END.md");
    }
  );

  it("uninstall 保留本地文件夹并移除全局提示词区块", () => {
    const kb = path.join(root, "kb");
    const claude = path.join(home, ".claude", "CLAUDE.md");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, "# 全局偏好\n始终用中文回答。\n");

    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(fs.readFileSync(claude, "utf8")).toContain("KNOWBASE:START");

    const u = knowbase(["uninstall"]);
    expect(u.code).toBe(0);
    expect(u.out).toContain("保留");
    // 知识库目录仍在
    expect(fs.existsSync(kb)).toBe(true);
    // 全局提示词区块已移除，但原有偏好保留
    const after = fs.readFileSync(claude, "utf8");
    expect(after).toContain("始终用中文回答");
    expect(after).not.toContain("KNOWBASE:START");
  });

  it("KNOWBASE_SKIP_AUTOSTART=1 时 uninstall 不注销真实的自启作业", () => {
    // 回归测试。launchd 的作业标签是硬编码常量、域名取自 uid，两者都不受 HOME
    // 影响，所以测试里跑 `knowbase uninstall` 会 bootout 开发者本机真实的
    // com.knowbase.daemon —— 这曾让开发者自己的知识库同步在跑测试时静默停摆。
    // init 早就有这道守卫，uninstall 漏了。
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    const u = knowbase(["uninstall"]);
    expect(u.code).toBe(0);
    expect(u.out).toContain("已跳过自启注销");
    expect(u.out).not.toContain("已注销开机自启");
    // 其余卸载动作照常完成
    expect(u.out).toContain("保留");
    expect(fs.existsSync(path.join(home, ".config", "knowbase", "config.json"))).toBe(
      false
    );
  });

  it("--interval 非法值直接报错", () => {
    const kb = path.join(root, "kb");
    const bad = knowbase(["init", bare, "--dir", kb, "--interval", "abc"]);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("--interval");

    const tooSmall = knowbase(["init", bare, "--dir", kb, "--interval", "2"]);
    expect(tooSmall.code).not.toBe(0);
  });

  it("uninstall 后 config 被移除，status 回到未接入引导", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(knowbase(["uninstall"]).code).toBe(0);
    const cfgPath = path.join(home, ".config", "knowbase", "config.json");
    expect(fs.existsSync(cfgPath)).toBe(false);
    const st = knowbase(["status"]);
    expect(st.code).toBe(0);
    expect(st.out).toContain("尚未接入");
  });

  it("未接入时 status 给出引导", () => {
    const st = knowbase(["status"]);
    expect(st.code).toBe(0);
    expect(st.out).toContain("尚未接入");
  });
});


