import fs from "node:fs";
import path from "node:path";
import { DEFAULT_BRANCH, Logger, exporterLogPath, exporterHealthPath } from "../config.js";
import * as git from "../git.js";
import { LarkClient } from "../exporter/lark-client.js";
import { ExporterHealth } from "../exporter/health.js";
import { runExportOnce, runExporterDaemon, ExporterConfig } from "../exporter/exporter.js";

const DEFAULT_EXPORTER_INTERVAL = 120;
const DEFAULT_ENDPOINT = "https://open.feishu.cn";

export interface ParsedExporterArgs {
  repoDir: string;
  branch: string;
  interval: number;
  /** 原始 --space 值，便于错误信息回显。 */
  spaceArg: string;
  /** space_id：直给，或从 space 首页形态 URL 中解析出。 */
  spaceId?: string;
  /** 节点形态 URL 时的 token；运行期需 client.getNode 解析出 space_id。 */
  nodeToken?: string;
  /** URL host 或显式 --host（显式优先）。 */
  host?: string;
  /** 显式 --root（优先于节点 URL 解析出的 token）。 */
  rootToken?: string;
  inboxUrl?: string;
  once: boolean;
  full: boolean;
  appId: string;
  appSecret: string;
  endpoint: string;
  /** 非空即不可运行。 */
  errors: string[];
}

/**
 * `--space` 三种形态（brief）：
 * ① 纯 space_id（不含 "/"）：必须配合 --host；
 * ② space 首页 URL `https://<host>/wiki/space/<space_id>`；
 * ③ 节点 URL `https://<host>/wiki/<node_token>`（子树根就是该节点，运行期靠
 *    client.getNode 补齐 space_id）。
 * 用 "://" 判断是否为 URL 形态，而不是简单看有无 "/"——纯 space_id 理论上不该
 * 含 "/"，但更稳妥的判据是「用户是不是贴了一个网址」。
 */
function parseSpaceArg(
  spaceArg: string,
  errors: string[]
): { host?: string; spaceId?: string; nodeToken?: string } {
  if (spaceArg.includes("://")) {
    let url: URL;
    try {
      url = new URL(spaceArg);
    } catch {
      errors.push(`--space 不是合法 URL：${spaceArg}`);
      return {};
    }
    const host = url.hostname;
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (segments[0] !== "wiki" || segments.length < 2) {
      errors.push(
        `--space URL 无法识别（应形如 https://<host>/wiki/<node_token> 或 ` +
          `https://<host>/wiki/space/<space_id>）：${spaceArg}`
      );
      return { host };
    }
    if (segments[1] === "space" && segments[2]) {
      return { host, spaceId: segments[2] };
    }
    return { host, nodeToken: segments[1] };
  }
  // 纯 space_id：host 由调用方从 --host 补齐（此处不知道 --host，交给调用方校验）
  return { spaceId: spaceArg };
}

/**
 * 纯函数：解析 + 校验 `knowbase exporter` 的参数与环境变量，返回配置或错误列表。
 * 不做任何 I/O（不读文件、不发请求），因此可以直接单测每一条解析/校验规则。
 */
export function parseExporterArgs(
  opts: Record<string, string | boolean | undefined>,
  env: NodeJS.ProcessEnv
): ParsedExporterArgs {
  const errors: string[] = [];

  const repoOpt = typeof opts.repo === "string" ? opts.repo.trim() : "";
  const repoDir = repoOpt !== "" ? path.resolve(repoOpt) : "";
  if (!repoDir) {
    errors.push(
      "缺少 --repo <已 clone 的镜像仓库路径>：先用 `knowbase init` 或 `git clone` 把飞书镜像仓库拉到本地，再把该目录路径传给 --repo。"
    );
  }

  const spaceArg = typeof opts.space === "string" ? opts.space.trim() : "";
  const hostOpt = typeof opts.host === "string" ? opts.host.trim() : "";
  let host: string | undefined;
  let spaceId: string | undefined;
  let nodeToken: string | undefined;
  if (!spaceArg) {
    errors.push("缺少 --space <wiki 链接或 space_id>");
  } else {
    const r = parseSpaceArg(spaceArg, errors);
    host = r.host;
    spaceId = r.spaceId;
    nodeToken = r.nodeToken;
    if (!host && !hostOpt) {
      errors.push(
        `--space 为纯 space_id 时必须显式提供 --host（如 --host acme.feishu.cn）：${spaceArg}`
      );
    }
  }
  // --host 显式给出时优先于从 URL 解析出的 host。
  if (hostOpt) host = hostOpt;

  const branch = typeof opts.branch === "string" && opts.branch.trim() !== "" ? opts.branch.trim() : DEFAULT_BRANCH;

  let interval = DEFAULT_EXPORTER_INTERVAL;
  if (typeof opts.interval === "string" && opts.interval.trim() !== "") {
    const n = parseInt(opts.interval, 10);
    // 非法值（非数字、≤0）静默回落默认，不算错误——命令依然可运行。
    if (Number.isInteger(n) && n > 0) interval = n;
  }

  const rootToken = typeof opts.root === "string" && opts.root.trim() !== "" ? opts.root.trim() : undefined;
  const inboxUrl = typeof opts.inboxUrl === "string" && opts.inboxUrl.trim() !== "" ? opts.inboxUrl.trim() : undefined;
  const once = opts.once === true;
  const full = opts.full === true;
  // --full 传给 daemon 会让 fullCheckMs 恒为 0：每一轮都变成全量对账，
  // 24h 窗口形同虚设、白白拉全树重渲染——只在 --once 场景下这是「本轮强制」的一次性行为。
  if (full && !once) {
    errors.push("--full 只能与 --once 连用（daemon 模式每 24h 自动全量对账）");
  }

  // 凭据：命令行参数优先，环境变量兜底——所有参数都可以只通过启动命令传入；
  // 注意 --app-secret 走命令行会留在 shell history / ps 输出里，长驻部署仍推荐 env。
  const appIdOpt = typeof opts.appId === "string" ? opts.appId.trim() : "";
  const appSecretOpt = typeof opts.appSecret === "string" ? opts.appSecret.trim() : "";
  const appId = appIdOpt !== "" ? appIdOpt : env.KNOWBASE_LARK_APP_ID?.trim() ?? "";
  const appSecret = appSecretOpt !== "" ? appSecretOpt : env.KNOWBASE_LARK_APP_SECRET?.trim() ?? "";
  if (!appId) {
    errors.push(
      "缺少 App ID：通过 --app-id <id> 传入，或设置环境变量 KNOWBASE_LARK_APP_ID。" +
        "先在飞书开放平台（open.feishu.cn）创建一个企业自建应用，取「凭证与基础信息」里的 App ID。"
    );
  }
  if (!appSecret) {
    errors.push(
      "缺少 App Secret：通过 --app-secret <secret> 传入，或设置环境变量 KNOWBASE_LARK_APP_SECRET。" +
        "在同一个应用的「凭证与基础信息」里复制 App Secret；并确认已把该应用的机器人加入目标知识空间（否则拉取会因无权限失败）。"
    );
  }
  const endpointOpt = typeof opts.endpoint === "string" ? opts.endpoint.trim() : "";
  const endpointEnv = env.KNOWBASE_LARK_ENDPOINT?.trim() ?? "";
  const endpoint = endpointOpt !== "" ? endpointOpt : endpointEnv !== "" ? endpointEnv : DEFAULT_ENDPOINT;

  return {
    repoDir,
    branch,
    interval,
    spaceArg,
    spaceId,
    nodeToken,
    host,
    rootToken,
    inboxUrl,
    once,
    full,
    appId,
    appSecret,
    endpoint,
    errors,
  };
}

/**
 * 校验 `--repo` 必须是已 clone 镜像仓库的根目录本身（finding#1）：
 * - 指向非 git 目录：exporter 每轮都会静默 add/commit 失败（git 报错），却对外表现为
 *   「一直不发布」，很难定位；
 * - 指向某个仓库内部的子目录：git 命令会顺着 --show-toplevel 找到上级仓库根，
 *   导致改动被提交/推送到一个用户完全没预料到的（可能是别人的）origin。
 * 抽成独立的薄函数（内部仍需 shell 出 git + fs.realpathSync，非纯函数）方便单测两种坏路径。
 */
export function validateRepoRoot(repoDir: string): string | null {
  const REPO_ROOT_ERROR =
    "--repo 必须指向一个已 clone 的镜像仓库根目录（当前不是 git 仓库根）：先 git clone <镜像仓库> 再指向它";
  const top = git.toplevel(repoDir);
  if (top === null) return REPO_ROOT_ERROR;
  try {
    if (fs.realpathSync(top) !== fs.realpathSync(repoDir)) return REPO_ROOT_ERROR;
  } catch {
    return REPO_ROOT_ERROR;
  }
  return null;
}

/**
 * `knowbase exporter`：解析参数 → 组装 LarkClient/Logger → `--once` 跑一轮，
 * 否则起守护循环。节点 URL 形态（parsed.nodeToken 有值且 spaceId 为空）需要先用
 * client.getNode 解析出 space_id；此时若用户没有显式 --root，节点 token 本身
 * 就是子树根。
 */
export async function cmdExporter(opts: Record<string, string | boolean | undefined>): Promise<number> {
  const parsed = parseExporterArgs(opts, process.env);
  if (parsed.errors.length > 0) {
    console.error("✗ 无法启动 exporter：");
    for (const e of parsed.errors) console.error(`  - ${e}`);
    return 2;
  }

  const repoRootError = validateRepoRoot(parsed.repoDir);
  if (repoRootError) {
    console.error(`✗ ${repoRootError}`);
    return 2;
  }

  const logger = new Logger(exporterLogPath());
  const client = new LarkClient({ appId: parsed.appId, appSecret: parsed.appSecret, endpoint: parsed.endpoint });

  let spaceId = parsed.spaceId;
  const rootToken = parsed.rootToken ?? parsed.nodeToken;
  if (!spaceId && parsed.nodeToken) {
    try {
      const { space_id } = await client.getNode(parsed.nodeToken);
      if (!space_id) {
        console.error(`✗ 无法从节点 ${parsed.nodeToken} 解析出 space_id（飞书接口未返回）`);
        return 1;
      }
      spaceId = space_id;
    } catch (e) {
      console.error(`✗ 解析 --space 节点链接失败：${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  if (!spaceId || !parsed.host) {
    // 理论上 parseExporterArgs 已保证这两者都有值，走到这里是实现 bug 而非用户输入问题。
    console.error("✗ 内部错误：未能确定 space_id / host");
    return 2;
  }

  const cfg: ExporterConfig = {
    repoDir: parsed.repoDir,
    branch: parsed.branch,
    spaceId,
    host: parsed.host,
    rootToken,
    inboxUrl: parsed.inboxUrl,
    // --full：本轮强制全量对账（忽略 last_full_check_at 窗口）。
    fullCheckMs: parsed.full ? 0 : undefined,
  };

  // 启动摘要：绝不打印 App Secret。
  console.log(`• repo: ${cfg.repoDir}`);
  console.log(`• space: ${cfg.spaceId}  host: ${cfg.host}${cfg.rootToken ? `  root: ${cfg.rootToken}` : ""}`);
  console.log(`• branch: ${cfg.branch}  interval: ${parsed.interval}s  模式: ${parsed.once ? "once" : "daemon"}`);

  const health = new ExporterHealth(exporterHealthPath());
  if (parsed.once) {
    const result = await runExportOnce(cfg, { client, logger });
    health.record(result);
    logger.log(
      `exporter(once): exported=${result.exported} moved=${result.moved} removed=${result.removed} ` +
        `pushed=${result.pushed}${result.error ? ` error=${result.error}` : ""}`
    );
    if (result.error) {
      console.error(`✗ ${result.error}`);
      console.error(`  详见日志：${logger.path()}`);
      return 1;
    }
    console.log(
      `✓ 完成：导出 ${result.exported}  移动 ${result.moved}  删除 ${result.removed}` +
        `${result.pushed ? "  已推送" : result.committed ? "  已提交（未推送）" : ""}`
    );
    if (result.exported === 0 && result.moved === 0 && result.removed === 0) {
      // 冒烟场景最常见的坑：bot 未加入知识空间时飞书对子树列举返回空列表而非报错
      console.log(
        "  提示：若为首次运行且知识库非空，请检查应用机器人是否已加入该知识空间（知识库设置 → 成员 → 添加成员）"
      );
    }
    return 0;
  }

  await runExporterDaemon(cfg, { client, logger }, {
    intervalSec: parsed.interval,
    onCycle: (result, summary) => {
      health.record(result);
      if (result.error) console.error(summary);
      else console.log(summary);
    },
  });
  return 0;
}
