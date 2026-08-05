import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  configExists,
  configPath,
  loadConfig,
  logPath,
  readDaemonState,
  pidAlive,
  isPaused,
} from "../config.js";
import * as git from "../git.js";
import { getAutostart } from "../platform/index.js";
import { readIndex, INDEX_MAX_BYTES } from "../agent-config.js";
import {
  planSkills,
  readExistingTargets,
  readSkillSources,
  skillsHomeDir,
} from "../skills-sync.js";

/** 递归扫描冲突副本（跳过 .git / node_modules，限制深度防止巨树卡顿）。 */
function findConflictCopies(dir: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 8) return acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      findConflictCopies(full, depth + 1, acc);
    } else if (e.name.includes(".conflict-")) {
      acc.push(full);
    }
  }
  return acc;
}

function fmtTime(iso?: string): string {
  if (!iso) return "从未";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  const rel =
    mins < 1 ? "刚刚" : mins < 60 ? `${mins} 分钟前` : `${Math.floor(mins / 60)} 小时前`;
  return `${d.toLocaleString()}（${rel}）`;
}

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

/** `knowbase status`：一屏看清健康度。 */
export function cmdStatus(): number {
  // 版本放在未接入 early return 之前：排查「装的是哪个版本」不该以接入为前提
  console.log(`CLI 版本：  ${pkg.version}`);
  if (!configExists()) {
    console.log("尚未接入。运行 `knowbase init <git-url>` 完成一次性接入。");
    return 0;
  }
  const cfg = loadConfig();
  const anomalies: string[] = [];

  console.log(`知识库目录：${cfg.dir}`);
  console.log(`远端仓库：  ${cfg.repoUrl}  (分支 ${cfg.branch})`);
  console.log(`配置文件：  ${configPath()}`);
  console.log("");

  // 守护进程
  const state = readDaemonState();
  const running = !!state && pidAlive(state.pid);
  let installed = false;
  try {
    installed = getAutostart().isInstalled();
  } catch {
    installed = false;
  }
  if (running) {
    console.log(`守护进程：  ● 运行中（pid ${state!.pid}）`);
  } else {
    console.log("守护进程：  ○ 未运行");
    anomalies.push(
      installed
        ? "守护进程已注册自启但当前未运行——查看日志排查，或重启后由服务管理器拉起。"
        : "守护进程未运行且未注册自启——运行 `knowbase init` 重新接入。"
    );
  }
  console.log(`开机自启：  ${installed ? "已注册" : "未注册"}`);
  console.log(`上次正常检查：${fmtTime(state?.lastOkCycleAt)}（含「已一致，无需同步」）`);
  console.log(`上次内容同步：${fmtTime(state?.lastSyncOkAt)}`);
  if (state?.lastError) {
    console.log(`最近一次错误：${state.lastError}`);
  }

  // 残留锁检测（正常时锁会被守护进程 10 分钟阈值自愈；这里提前给出可见提示）
  const lockFile = path.join(cfg.dir, ".git", "index.lock");
  if (fs.existsSync(lockFile)) {
    try {
      const ageMin = Math.floor((Date.now() - fs.statSync(lockFile).mtimeMs) / 60000);
      if (ageMin >= 10) {
        anomalies.push(
          `存在残留的 .git/index.lock（${ageMin} 分钟前）——守护进程会自动清除；也可手动删除 ${lockFile}`
        );
      }
    } catch {
      // ignore
    }
  }

  // 暂停状态（醒目）
  if (isPaused(cfg.dir)) {
    console.log("");
    console.log("⏸  已暂停自动同步（存在 .knowbase-pause）。运行 `knowbase resume` 恢复。");
  }

  // 本地待推送
  console.log("");
  let uncommitted = 0;
  let ahead = 0;
  if (git.isRepo(cfg.dir)) {
    uncommitted = git.changedFiles(cfg.dir).length;
    ahead = git.aheadCount(cfg.dir, `origin/${cfg.branch}`);
  }
  console.log(`本地未提交改动：${uncommitted} 个文件`);
  console.log(`本地领先远端：  ${ahead} 个提交（未推送，以上次 fetch 为准）`);

  // push 熔断（无写权限）——必须醒目：用户看到的「本地领先 N 个提交」
  // 在这种状态下意味着这些提交永远推不出去。
  if (state?.pushBlocked) {
    const pb = state.pushBlocked;
    console.log("");
    console.log(`⚠ 无 push 权限：本地 ${ahead} 个提交只在本机，未同步给团队。`);
    console.log(`  原因：${pb.reason}`);
    if (running) {
      console.log(
        `  下次自动重试：${new Date(pb.nextProbeAt).toLocaleString()}。` +
          `补上权限后会自动恢复，无需手动操作。`
      );
      anomalies.push(
        `无 push 权限，${ahead} 个提交未推送给团队——请联系仓库管理员补上写权限，之后自动恢复。`
      );
    } else {
      console.log(`  守护进程未运行，恢复运行后会自动重试。`);
      anomalies.push(
        `无 push 权限，${ahead} 个提交未推送给团队——请先恢复守护进程运行，并联系仓库管理员补上写权限，之后自动恢复。`
      );
    }
  }

  // agent 提示词索引（这个机制默认静默运行，必须给出可见性）
  console.log("");
  if (cfg.agentConfig === false) {
    console.log("agent 提示词：已关闭（init 时用了 --no-agent-config）");
  } else {
    const idx = readIndex(cfg.dir);
    if (!idx.name) {
      // 不计入 anomalies：knowbase 不生成也不播种 index.md，「根目录还没有索引」
      // 是每个团队 day one 的正常状态，计入会让 status 永久非零退出、
      // 把拿退出码做监控的包装脚本永久标红。
      console.log(
        "agent 提示词：已启用；知识库根目录暂无 index.md，区块中改为提示 agent 直接 grep 全库"
      );
    } else if ((idx.text ?? "").trim() === "") {
      // 与 buildBlock 的空索引判断保持同一口径：文件在但没内容，不报「已注入 0.0KB」
      console.log(
        `agent 提示词：已启用；${idx.name} 存在但为空，区块中改为提示 agent 直接 grep 全库`
      );
    } else {
      const kb = (idx.bytes / 1024).toFixed(1);
      const note = idx.truncated ? `，超 ${INDEX_MAX_BYTES / 1024}KB 已截断` : "";
      console.log(`agent 提示词：已注入 ${idx.name}（${kb}KB${note}）`);
    }
  }

  // 团队 skills（同样默认静默运行，必须给出可见性）
  console.log("");
  if (cfg.skills === false) {
    console.log("团队 skills：已关闭（init 时用了 --no-skills）");
  } else {
    // 直接复用 planSkills 的判定，不在这里另算一遍：status 曾用
    // `sources.filter(...) + fs.existsSync` 重算 foreign，而 existsSync **跟随**
    // 软链、readExistingTargets **不跟随**，于是「org-a 是条悬空软链」这种
    // 分发被永久阻塞的状态在 status 里完全看不见（还会打印「已分发 0 个」了事）。
    // status 存在的唯一理由就是给这套静默机制提供可见性，判定分叉就等于没有。
    // planSkills 是纯函数、零 fs 写入，status 保持只读这条约束不受影响。
    const { sources, invalid, protectedTargets } = readSkillSources(cfg.dir);
    const existing = readExistingTargets(skillsHomeDir());
    const plan = planSkills(sources, existing, protectedTargets);
    const delivered = plan.filter(
      (c) => c.action === "created" || c.action === "updated" || c.action === "unchanged"
    ).length;
    if (sources.length === 0 && existing.every((e) => !e.marker)) {
      // 不计入 anomalies：knowbase 不播种 skills/，「还没有团队 skill」
      // 是每个团队 day one 的正常状态。
      console.log("团队 skills：已启用；知识库暂无 skills/ 目录");
    } else {
      console.log(`团队 skills：已分发 ${delivered} 个（org-*），源 ${sources.length} 个`);
    }
    for (const c of invalid) {
      console.log(`  ⚠ 跳过 ${c.name}：${c.reason}`);
      anomalies.push(`团队 skill ${c.name} 未分发：${c.reason}`);
    }
    for (const c of plan) {
      if (c.action !== "foreign") continue;
      console.log(`  ⚠ 跳过 ${c.target}：${c.reason}`);
      anomalies.push(
        `团队 skill ${c.name} 未分发：~/.claude/skills/${c.target} 不是 knowbase 托管的，未覆盖；改名后即可收到团队版`
      );
    }
  }

  // 冲突副本
  const copies = findConflictCopies(cfg.dir);
  if (copies.length > 0) {
    console.log("");
    console.log(`⚠ 待处理冲突副本 ${copies.length} 个：`);
    for (const c of copies.slice(0, 20)) {
      console.log(`  - ${path.relative(cfg.dir, c)}`);
    }
    if (copies.length > 20) console.log(`  …… 还有 ${copies.length - 20} 个`);
    anomalies.push(`存在 ${copies.length} 个冲突副本待人工/AI 合并。`);
  } else {
    console.log("冲突副本：      无");
  }

  // 远端连通性 / 凭证
  console.log("");
  console.log("检查远端连通性 ...");
  const ls = git.lsRemote(cfg.repoUrl, 15000);
  if (git.ok(ls)) {
    console.log("远端连通性：  ✓ 正常");
  } else {
    const text = (ls.stderr + ls.stdout).toLowerCase();
    const authIssue =
      text.includes("authentication") ||
      text.includes("permission") ||
      text.includes("could not read") ||
      text.includes("access denied") ||
      text.includes("denied");
    console.log(`远端连通性：  ✗ 失败`);
    anomalies.push(
      authIssue
        ? "远端凭证失效或无权限——重新配置 SSH key / PAT 后再试。"
        : "远端不可达（网络问题）——恢复网络后守护进程会自动补同步。"
    );
  }

  // 异常汇总（AC4）
  console.log("");
  if (anomalies.length === 0) {
    console.log("✓ 一切正常。");
  } else {
    console.log("需要注意：");
    for (const a of anomalies) console.log(`  ⚠ ${a}`);
    console.log("");
    console.log(`日志：${logPath()}`);
  }
  return anomalies.length === 0 ? 0 : 1;
}
