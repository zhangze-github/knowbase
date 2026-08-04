import fs from "node:fs";
import path from "node:path";
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

/** `knowbase status`：一屏看清健康度。 */
export function cmdStatus(): number {
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

  // agent 提示词索引（这个机制默认静默运行，必须给出可见性）
  console.log("");
  if (cfg.agentConfig === false) {
    console.log("agent 提示词：已关闭（init 时用了 --no-agent-config）");
  } else {
    const idx = readIndex(cfg.dir);
    if (!idx.name) {
      console.log("agent 提示词：已启用，但知识库根目录没有 index.md");
      anomalies.push(
        "知识库根目录缺少 index.md——agent 拿不到内容地图，确认索引维护 agent 是否在运行。"
      );
    } else {
      const kb = (idx.bytes / 1024).toFixed(1);
      const note = idx.truncated ? `，超 ${INDEX_MAX_BYTES / 1024}KB 已截断` : "";
      console.log(`agent 提示词：已注入 ${idx.name}（${kb}KB${note}）`);
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
