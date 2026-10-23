import fs from "node:fs";
import {
  configExists,
  configPath,
  loadConfig,
  clearDaemonState,
  daemonStdoutPath,
  Logger,
} from "../config.js";
import { getAutostart } from "../platform/index.js";
import { uninstallAgentConfig } from "../agent-config.js";
import { uninstallSkills } from "../skills-sync.js";
import { isMirrorMode, setMirrorLock } from "../mirror.js";

/** `knowbase uninstall`：注销自启、停止守护进程、保留本地文件夹。 */
export function cmdUninstall(): number {
  let dir: string | null = null;
  let hermesHome: string | undefined;
  if (configExists()) {
    try {
      const cfg = loadConfig();
      dir = cfg.dir;
      hermesHome = cfg.hermesHome;
    } catch {
      dir = null;
    }
  }

  // 与 init 对称的守卫。launchd/systemd 的作业标签是硬编码常量、域名取自 uid，
  // 两者都不随 HOME 变化：测试把 HOME 指向临时目录也拦不住 bootout 打到开发者
  // 本机真实的 com.knowbase.daemon 上，跑一次测试就会把自己的知识库同步拆掉。
  if (process.env.KNOWBASE_SKIP_AUTOSTART === "1") {
    console.log("• 已跳过自启注销（KNOWBASE_SKIP_AUTOSTART=1）");
  } else {
    try {
      getAutostart().uninstall();
      console.log("• 已注销开机自启并停止守护进程");
    } catch (e) {
      console.warn(`⚠ 注销自启时出错：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  clearDaemonState();

  // 镜像模式下把上锁的文件恢复可写：uninstall 保留本地文件夹（product.md 非目标），
  // 留一堆 444 文件会让用户之后整理自己的目录时莫名其妙
  if (dir && isMirrorMode(dir)) {
    try {
      const n = setMirrorLock(dir, false);
      if (n > 0) console.log(`• 已解除镜像只读锁（${n} 个文件恢复可写）`);
    } catch (e) {
      console.warn(
        `⚠ 解除只读锁时出错：${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // 移除写入各 AI agent 全局提示词的托管区块
  try {
    const removals = uninstallAgentConfig(undefined, hermesHome);
    for (const r of removals) {
      if (r.removed) console.log(`• 已从 ${r.name} 全局提示词移除知识库区块：${r.file}`);
      if (r.error) console.warn(`⚠ ${r.name} 知识库上下文未移除：${r.file}：${r.error}`);
    }
  } catch (e) {
    console.warn(`⚠ 移除 agent 提示词区块时出错：${e instanceof Error ? e.message : String(e)}`);
  }

  // 移除分发到各生效目标的团队 skills 副本（无托管标记的目录一律不碰）
  try {
    const removals = uninstallSkills(undefined, hermesHome);
    const removed = removals.filter((r) => r.removed);
    if (removed.length > 0) {
      const groups = new Map<string, string[]>();
      for (const r of removed) {
        const arr = groups.get(r.tool) ?? [];
        arr.push(r.target);
        groups.set(r.tool, arr);
      }
      console.log(
        "• 已移除团队 skills：" +
          [...groups.entries()]
            .map(([tool, ts]) => `${tool} ${ts.length} 个（${ts.join(", ")}）`)
            .join("；")
      );
    }
    // removed === false 是**真的删失败了**（与 uninstallAgentConfig 的
    // removed: false 语义相反，见 SkillRemoval 的注释），绝不能静默过滤掉：
    // 这份团队 skill 仍会被 Claude Code 加载，而配置马上就被删掉、status 也
    // 不再工作，用户再没有入口能发现它。
    for (const r of removals) {
      if (r.removed) continue;
      console.warn(`⚠ 未能移除 ${r.path}：${r.error ?? "未知原因"}`);
      console.warn(
        `  该团队 skill 仍会被 ${r.tool} 加载，请手动删除这个目录（通常是权限问题）。`
      );
    }
  } catch (e) {
    console.warn(
      `⚠ 移除团队 skills 时出错：${e instanceof Error ? e.message : String(e)}`
    );
  }

  new Logger().log("uninstall：已注销自启并停止守护进程");

  // 移除配置与守护进程 stdout（保留 knowbase.log 供事后排查）
  try {
    fs.rmSync(configPath(), { force: true });
    fs.rmSync(daemonStdoutPath(), { force: true });
  } catch {
    // ignore
  }

  console.log("• 已清理守护进程状态与配置（日志保留以便排查）");
  if (dir) {
    console.log("");
    console.log(`✓ 已卸载。本地知识库文件夹已保留，不会删除：`);
    console.log(`  ${dir}`);
    console.log("  如需彻底删除，请自行 rm -rf 该目录。");
  } else {
    console.log("✓ 已卸载。");
  }
  return 0;
}
