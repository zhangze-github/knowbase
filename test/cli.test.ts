import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir, makeOrigin, makeBareOrigin, g } from "./helpers.js";

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
  bare = makeOrigin(root);
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
  });

  it("init → 种入规则、写配置、跳过自启", () => {
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

    // union 规则
    expect(fs.readFileSync(path.join(kb, ".gitattributes"), "utf8")).toContain(
      "*.md merge=union"
    );
    expect(fs.readFileSync(path.join(kb, ".gitignore"), "utf8")).toContain(
      ".knowbase-pause"
    );

    // 默认自动配置 Claude Code / Codex 全局提示词
    const claude = path.join(home, ".claude", "CLAUDE.md");
    const codex = path.join(home, ".codex", "AGENTS.md");
    expect(fs.readFileSync(claude, "utf8")).toContain(kb);
    expect(fs.readFileSync(codex, "utf8")).toContain(kb);
    expect(r.out).toContain("全局提示词");
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

  it("init → 写文件 → sync 推送 → 另一 clone 可见", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    fs.writeFileSync(path.join(kb, "hello.md"), "hello world\n");
    const s = knowbase(["sync"]);
    expect(s.code).toBe(0);
    expect(s.out).toContain("已推送到远端");

    // 另一 clone 验证
    const other = path.join(root, "other");
    g(root, "clone", bare, other);
    expect(fs.existsSync(path.join(other, "hello.md"))).toBe(true);
  });

  it("pause 醒目显示 / resume 恢复", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    const p = knowbase(["pause"]);
    expect(p.code).toBe(0);
    expect(fs.existsSync(path.join(kb, ".knowbase-pause"))).toBe(true);

    const st = knowbase(["status"]);
    expect(st.out).toContain("已暂停");

    const rs = knowbase(["resume"]);
    expect(rs.code).toBe(0);
    expect(fs.existsSync(path.join(kb, ".knowbase-pause"))).toBe(false);
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

  it("status 反映：守护进程未运行 + 冲突副本（AC4）", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    // 制造一个冲突副本文件
    fs.writeFileSync(
      path.join(kb, "note.conflict-hostZ-20260729T120000.txt"),
      "local version\n"
    );

    const st = knowbase(["status"]);
    // 守护进程未运行（测试未启动 daemon）
    expect(st.out).toContain("守护进程");
    expect(st.out).toContain("未运行");
    // 冲突副本被检出
    expect(st.out).toContain("冲突副本");
    expect(st.out).toContain("note.conflict-");
    // 有异常 → 退出码非 0
    expect(st.code).not.toBe(0);
  });

  it("status 报告索引注入状态：缺失 / 已注入 / 已关闭", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    // 仓库无 index.md → 给出提示，但这是 day one 的正常状态，不算异常
    const missing = knowbase(["status"]);
    expect(missing.out).toContain("agent 提示词");
    expect(missing.out).toContain("暂无 index.md");
    // 「需要注意」汇总里不得出现索引缺失（否则每个新团队的 status 永久非零退出）
    const attention = missing.out.split("需要注意：")[1] ?? "";
    expect(attention).not.toContain("index.md");

    // 有 index.md → 报告文件名与体积
    fs.writeFileSync(path.join(kb, "index.md"), "# 索引\n- 角色/\n");
    const injected = knowbase(["status"]);
    expect(injected.out).toMatch(/agent 提示词：已注入 index\.md（[\d.]+KB）/);

    // 关闭开关 → 报告已关闭
    expect(knowbase(["init", bare, "--dir", kb, "--no-agent-config"]).code).toBe(0);
    expect(knowbase(["status"]).out).toContain("agent 提示词：已关闭");
  });

  it("status 报告团队 skills：暂无 / 已分发 / 已关闭", () => {
    const kb = path.join(root, "kb");

    // 知识库没有 skills/ 目录
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    expect(knowbase(["status"]).out).toContain("知识库暂无 skills/ 目录");

    // 关闭
    expect(knowbase(["init", bare, "--dir", kb, "--no-skills"]).code).toBe(0);
    expect(knowbase(["status"]).out).toContain("--no-skills");
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

  it("零字节 index.md → 区块回退文案与 status 口径一致", () => {
    const kb = path.join(root, "kb");
    const claude = path.join(home, ".claude", "CLAUDE.md");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    fs.writeFileSync(path.join(kb, "index.md"), "");
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    // 区块：走回退文案，不出现空的索引小节
    const content = fs.readFileSync(claude, "utf8");
    expect(content).not.toContain("### 知识库索引");
    expect(content).toContain("暂无");
    // status：报告「存在但为空」，不报「已注入 0.0KB」
    const st = knowbase(["status"]);
    expect(st.out).toContain("index.md 存在但为空");
    expect(st.out).not.toContain("已注入 index.md（0.0KB）");
  });

  it("索引含 KNOWBASE:END 字样时 init→uninstall 全链路不吞用户内容", () => {
    const kb = path.join(root, "kb");
    const claude = path.join(home, ".claude", "CLAUDE.md");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, "# 全局偏好\n始终用中文回答。\n");

    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);
    // 索引正文里出现区块结束标记字样（例如索引记录了 knowbase 自身的文档）
    fs.writeFileSync(
      path.join(kb, "index.md"),
      "# 索引\n- knowbase/：区块以 KNOWBASE:END 收尾\n"
    );
    expect(knowbase(["init", bare, "--dir", kb]).code).toBe(0);

    const withBlock = fs.readFileSync(claude, "utf8");
    expect(withBlock).toContain("KNOWBASE_END"); // 已中和
    expect(withBlock.split("KNOWBASE:END").length - 1).toBe(1); // 真结束标记只有一个

    expect(knowbase(["uninstall"]).code).toBe(0);
    const after = fs.readFileSync(claude, "utf8");
    expect(after).toContain("始终用中文回答");
    expect(after).not.toContain("KNOWBASE");
    expect(after).not.toContain("knowbase/：");
  });

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

describe("status 展示 push 熔断", () => {
  it("pushBlocked 存在时给出只读模式提示并以非零退出", () => {
    const kb = path.join(root, "kb");
    expect(knowbase(["init", bare, "--dir", kb, "--no-agent-config"]).code).toBe(0);

    // status 只读状态文件，不需要真跑守护进程；直接构造一份。
    // 测试里 KNOWBASE_SKIP_AUTOSTART=1，init 不会产生 daemon.state.json，所以是新建。
    // pid 用当前进程（确实存活）→ status 判定「运行中」，避免多出一条无关 anomaly，
    // 让退出码 1 只由 pushBlocked 贡献。
    const statePath = path.join(home, ".config", "knowbase", "daemon.state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date(Date.UTC(2026, 7, 5, 11, 0, 0)).toISOString(),
          pushBlocked: {
            since: new Date(Date.UTC(2026, 7, 5, 12, 0, 0)).toISOString(),
            reason: "GitLab: You are not allowed to push code to this project.",
            nextProbeAt: new Date(Date.UTC(2026, 7, 5, 12, 5, 0)).toISOString(),
          },
        },
        null,
        2
      )
    );

    const r = knowbase(["status"]);
    expect(r.out).toContain("无 push 权限");
    expect(r.out).toContain("You are not allowed to push code to this project.");
    expect(r.out).toContain("无需手动操作");
    expect(r.code).toBe(1);
  });
});

describe("init 写权限预检", () => {
  it("无 push 权限时警告只读模式但不阻断接入", () => {
    const kb = path.join(root, "kb");
    const shimDir = makeDenyDryRunShim(path.join(root, "git-shim"));
    const r = knowbase(["init", bare, "--dir", kb, "--no-agent-config"], {
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    expect(r.code).toBe(0); // 不阻断
    expect(r.out).toContain("只读模式");
    expect(r.out).toContain("无需重新 init");
    // 配置照常写入，接入流程走完
    expect(fs.existsSync(path.join(home, ".config", "knowbase", "config.json"))).toBe(true);
  });

  it("有权限时不出现只读模式警告", () => {
    const kb = path.join(root, "kb");
    const r = knowbase(["init", bare, "--dir", kb, "--no-agent-config"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("只读模式");
  });

  it("无权限且需种入规则时：种规则分支走「暂不推送」", () => {
    // makeOrigin 预置的远端已经带 union / 忽略规则，ensureLine 恒为 false，
    // 走不到「种入规则」那段——用 makeBareOrigin 搭一个不含规则文件（但已有
    // 提交，满足 headBorn 守卫）的远端，让 seeded=true，才能覆盖这条分支。
    const kb = path.join(root, "kb");
    const bareNoRules = makeBareOrigin(root);
    const shimDir = makeDenyDryRunShim(path.join(root, "git-shim"));
    const r = knowbase(["init", bareNoRules, "--dir", kb, "--no-agent-config"], {
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    expect(r.code).toBe(0);
    // 锁住 readOnly 分支的新文案——变异测试验证过：回退 init.ts 里这段改写
    // 会让这条断言失败。
    expect(r.out).toContain("暂不推送");
    // 「守护进程会自动重试」这句旧文案只在「真实 push 失败且失败类型不是
    // denied（如网络抖动）」时才会输出；本用例 readOnly=true，代码根本不走
    // 真实 push，这句文案在只读路径上按构造不可达——就算去掉 readOnly 早退
    // 分支，makeBareOrigin 搭的远端也没有拒绝机制，真实 push 会直接成功；
    // 再给它装 denyPush 钩子，命中的也是 p.denied 分支、输出只读提示而非这
    // 句文案。没有能让这条断言产生意义的测试环境，因此不对它做断言，避免
    // 留一条名存实亡的断言误导后来者。
    //
    // 注：init.ts 里 p.denied 为真的那条警告分支（readOnly=false，但真实 push
    // 被拒）同样覆盖不到——要触发它需要「写权限预检（探测分支/dry-run）判定
    // 为有权限，但随后真实 push 却被拒」这种权限中途变化的场景，git shim 只能
    // 模拟固定的 --dry-run 拒绝，无法模拟这种时序竞争，不为此硬造场景。
  });
});
