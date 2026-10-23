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
} from "../config.js";
import * as git from "../git.js";
import { isMirrorMode, readMirrorManifest, mirrorFreshness } from "../mirror.js";
import { getAutostart } from "../platform/index.js";
import { readKbTree, TREE_MAX_BYTES } from "../agent-config.js";
import { additionalAgentConfigStatus } from "../agent-integrations.js";
import {
  planSkills,
  readExistingTargets,
  readSkillSources,
  skillTargets,
} from "../skills-sync.js";

/** 递归扫描冲突副本（跳过 .git / node_modules，限制深度防止巨树卡顿）。 */
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
  const mirrorMode = isMirrorMode(cfg.dir);
  const anomalies: string[] = [];

  console.log(`知识库目录：${cfg.dir}`);
  console.log(`远端仓库：  ${cfg.repoUrl}  (分支 ${cfg.branch})`);
  if (mirrorMode) {
    console.log("模式：      飞书镜像（只读，真相源在飞书知识库）");
  }
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
  if (mirrorMode) {
    const fresh = mirrorFreshness(readMirrorManifest(cfg.dir), new Date());
    if (fresh.unreadable) {
      console.log("镜像清单：  ✗ .knowbase-mirror.json 无法解析");
      anomalies.push("镜像清单损坏——exporter 侧可能异常，请联系知识库管理员。");
    } else {
      console.log(`镜像更新：  ${fmtTime(fresh.lastSyncAt ?? undefined)}`);
      console.log(`全量对账：  ${fmtTime(fresh.lastFullCheckAt ?? undefined)}`);
      if (fresh.stale) {
        anomalies.push(
          "镜像已超过 30 分钟未更新——exporter 可能停摆（本地内容仍可读），请联系知识库管理员。"
        );
      }
    }
    if (state?.lastDiscard) {
      const d = state.lastDiscard;
      const head = d.files.slice(0, 5).join(", ");
      console.log(
        `本地改动丢弃：${fmtTime(d.at)}，${d.files.length} 个文件（${head}${d.files.length > 5 ? " …" : ""}）——镜像只读，修改请走飞书`
      );
    }
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

  // agent 提示词目录树（这个机制默认静默运行，必须给出可见性）
  console.log("");
  if (cfg.agentConfig === false) {
    console.log("agent 提示词：已关闭（init 时用了 --no-agent-config）");
  } else {
    const tree = readKbTree(cfg.dir);
    if (tree.files === 0) {
      // 不计入 anomalies：knowbase 不生成也不播种任何文件，「知识库还没有文件」
      // 是每个团队 day one 的正常状态，计入会让 status 永久非零退出、
      // 把拿退出码做监控的包装脚本永久标红。
      console.log("agent 提示词：已启用；知识库暂无文件，区块中提示 agent 直接 grep 全库");
    } else {
      const kbSize = (tree.bytes / 1024).toFixed(1);
      const note = tree.truncated ? `，超 ${TREE_MAX_BYTES / 1024}KB 已截断` : "";
      // 折叠是常态而非异常（目录一宽就会发生），但必须可见：否则用户无从知道
      // 注入给 agent 的树并不是完整清单。
      const fold = tree.hidden > 0 ? `，其中 ${tree.hidden} 篇因目录过宽已折叠` : "";
      console.log(
        `agent 提示词：已注入目录树（${tree.files} 个文件${fold}，${kbSize}KB${note}）`
      );
    }
  }

  if (cfg.agentConfig !== false) {
    for (const s of additionalAgentConfigStatus(undefined, cfg.hermesHome)) {
      console.log(`知识库上下文（${s.name}）：${s.state}`);
      if (s.error) anomalies.push(`${s.name} 知识库上下文配置异常：${s.error}`);
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
    const targets = skillTargets(undefined, cfg.hermesHome);
    const perTarget = targets.map((t) => ({ t, existing: readExistingTargets(t.dir) }));
    // invalid.length === 0 是必要条件：invalid 非空说明 skills/ 目录确实存在、
    // 只是里面有坏源（如缺 description），这不是「还没有团队 skill」的 day one
    // 状态，而是需要人修的异常，「暂无 skills/ 目录」这句话在这种情况下是假的。
    if (
      sources.length === 0 &&
      invalid.length === 0 &&
      perTarget.every((p) => p.existing.every((e) => !e.marker))
    ) {
      // 不计入 anomalies：knowbase 不播种 skills/，「还没有团队 skill」
      // 是每个团队 day one 的正常状态。
      console.log("团队 skills：已启用；知识库暂无 skills/ 目录");
    } else {
      for (const { t, existing } of perTarget) {
        const plan = planSkills(sources, existing, protectedTargets);
        // 只数 updated + unchanged，**不含 created**：status 是只读命令，报告的是
        // 当前状态。created 的含义是「副本还不在盘上、下一次分发才会装」，把它算进
        // 「已分发」就是虚报——用户在 init 之前跑 status 会看到「已分发 3 个」而磁盘上
        // 一个都没有。updated 则确实在盘上（只是过期了，Claude Code 正在加载它），算。
        // 待装的那些由「源 M 个」这个差额体现：看到「已分发 0 个，源 3 个」就知道还没装上。
        const delivered = plan.filter(
          (c) => c.action === "updated" || c.action === "unchanged"
        ).length;
        console.log(`团队 skills（${t.name}）：已分发 ${delivered} 个（org-*），源 ${sources.length} 个`);
        for (const c of plan) {
          if (c.action !== "foreign") continue;
          console.log(`  ⚠ 跳过 ${c.target}：${c.reason}`);
          anomalies.push(
            `团队 skill ${c.name} 未分发：${path.join(t.dir, c.target)} 不是 knowbase 托管的，未覆盖；改名后即可收到团队版`
          );
        }
      }
    }
    // invalid 是源侧问题，与目标无关，只报一次；两个分支（day-one 判定为真/假）
    // 都要走到这里——day-one 判定为真时 sources 必为空，但 invalid 仍可能非空
    // （唯一的源坏了），此时仍要报出来，不能因为走了「暂无 skills/ 目录」分支就
    // 静默吞掉。
    for (const c of invalid) {
      console.log(`  ⚠ 跳过 ${c.name}：${c.reason}`);
      anomalies.push(`团队 skill ${c.name} 未分发：${c.reason}`);
    }
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
