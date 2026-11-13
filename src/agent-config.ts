import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ORG_PREFIX, SKILLS_SUBDIR } from "./skills-sync.js";
import { syncAdditionalAgentConfig, uninstallAdditionalAgentConfig } from "./agent-integrations.js";

/**
 * 把知识库集成片段写入各 AI agent 的全局提示词文件，使 agent 天然知道
 * 「组织知识库在哪、怎么读写」。用带标记的托管区块实现，幂等且可逆，
 * 不影响用户在同一文件中的其他内容。
 */

export const BLOCK_START = "<!-- KNOWBASE:START （由 knowbase 自动管理，勿手动编辑本区块） -->";
export const BLOCK_END = "<!-- KNOWBASE:END -->";

export interface AgentTarget {
  /** 展示名。 */
  name: string;
  /** 全局提示词文件绝对路径。 */
  file: string;
}

/** 各 agent 的全局提示词文件位置。 */
export function agentTargets(home: string = os.homedir()): AgentTarget[] {
  return [
    { name: "Claude Code", file: path.join(home, ".claude", "CLAUDE.md") },
    { name: "Codex", file: path.join(home, ".codex", "AGENTS.md") },
  ];
}

/** 内置 skill 的目录名与 name：完整目录、检索方法与写入流程都在这里，按需加载。 */
export const KB_SKILL_NAME = "knowbase";

/**
 * 常驻目录地图的字节上限。
 *
 * 常驻区块每次会话都进上下文，且在 Codex 里与全局、各项目 AGENTS.md 共用
 * 32 KiB 预算、在 Hermes 里受 4,000 字符上限约束，所以它的大小必须与知识库
 * 规模脱钩。地图只列目录与篇数、不列文件；完整文件清单放进内置 skill 的
 * references/catalog.md，按需读取。
 */
export const MAP_MAX_BYTES = 1536;

/** 地图最多展开的目录层数；在预算内自动取能放下的最深层数。 */
export const MAP_MAX_DEPTH = 4;

/**
 * 中和正文中的区块标记字样。
 *
 * 文件名、目录名来自飞书文档标题，完全可能出现 KNOWBASE:END（例如某篇文档
 * 记录 knowbase 自身）。若原样内嵌，upsertBlock / stripBlock 会匹配到提前
 * 出现的结束标记、切错位置，吞掉用户 CLAUDE.md 中区块之后的内容。
 */
export function neutralizeMarkers(text: string): string {
  return text.replace(/KNOWBASE:(START|END)/g, "KNOWBASE_$1");
}

/** 按字节上限截断，切点落在不超限的最后一个换行处。 */
export function truncateAtLine(text: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, truncated: false };
  const head = buf.subarray(0, max).toString("utf8");
  const cut = head.lastIndexOf("\n");
  // 无换行可切（单行超长）时退化为按字符切，并去掉多字节字符被切断产生的替换符
  // cut > 0 而非 >= 0 是有意为之：换行落在下标 0 会切出空正文，不如落到下面的字节级兜底
  const kept = cut > 0 ? head.slice(0, cut) : head.replace(/�+$/, "");
  return { text: kept, truncated: true };
}

/** 知识库里的一个目录节点（递归统计）。 */
export interface KbDirNode {
  name: string;
  /** 本目录直属文件名，已排序。 */
  files: string[];
  /** 子目录，已排序。 */
  dirs: KbDirNode[];
  /** 本目录及所有子目录的文件总数。 */
  total: number;
}

/**
 * 递归扫描知识库：目录与文件各自按默认字符串排序，保证跨平台（不同文件系统的
 * readdir 顺序不保证一致）确定性输出。
 * 跳过点开头的条目（.git、.knowbase-mirror.json 等管理文件）、node_modules 与
 * 仓库根 skills/——团队 skills 由客户端按需发现，不是知识文档。
 * 任意一层 readdir 失败（目录不存在、权限问题等）当作空，不向上抛：daemon 路径
 * 不能因为知识库目录一时不可读就崩掉。
 */
export function scanKb(dir: string, name = "", root = true): KbDirNode {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { name, files: [], dirs: [], total: 0 };
  }
  const visible = entries.filter((e) =>
    !e.name.startsWith(".") && e.name !== "node_modules" &&
    !(root && e.name === SKILLS_SUBDIR)
  );
  const dirs = visible
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((n) => scanKb(path.join(dir, n), n, false));
  const files = visible.filter((e) => !e.isDirectory()).map((e) => e.name).sort();
  const total = files.length + dirs.reduce((s, d) => s + d.total, 0);
  return { name, files, dirs, total };
}

function countDirs(node: KbDirNode): number {
  return node.dirs.reduce((s, d) => s + 1 + countDirs(d), 0);
}

function dirDepth(node: KbDirNode): number {
  return node.dirs.reduce((m, d) => Math.max(m, 1 + dirDepth(d)), 0);
}

function mapLines(node: KbDirNode, depth: number, indent: string, acc: string[]): void {
  for (const d of node.dirs) {
    acc.push(`${indent}${d.name}/（${d.total}）`);
    if (depth > 1) mapLines(d, depth - 1, indent + "  ", acc);
  }
}

export interface KbMap {
  /** 可直接内嵌的地图文本；知识库无文件时为 null。 */
  text: string | null;
  /** 知识库文件总数（不含 skills/ 等被跳过的条目）。 */
  files: number;
  /** 目录总数。 */
  dirs: number;
  /** 地图实际展开到第几层目录；0 表示没有子目录。 */
  depth: number;
  /** 根目录直属文件数。 */
  rootFiles: number;
  /** 即使只展开一层也超预算、被按行截断。 */
  truncated: boolean;
}

/**
 * 生成常驻目录地图：只列目录与递归篇数，不列文件。
 *
 * 为什么不再常驻文件清单：清单的大小随文档数线性增长，旧实现靠「每目录只列
 * 头尾各 5 篇」折叠来限宽，但实测 110 篇时几乎没有目录触发折叠、清单已逼近
 * 8KB 上限，再涨就会被按行截断。目录地图的大小只随目录数增长，并且在预算内
 * 自适应地选最深能放下的层数——知识库变大时地图变粗，而不是变长。
 */
export function readKbMap(dir: string): KbMap {
  const root = scanKb(dir);
  const dirs = countDirs(root);
  if (root.total === 0) {
    return { text: null, files: 0, dirs, depth: 0, rootFiles: 0, truncated: false };
  }
  let depth = 0;
  let lines: string[] = [];
  // 从树的真实深度（不超过上限）开始往浅试：只有一层目录时不能报「展开到第 4 层」
  for (let d = Math.min(MAP_MAX_DEPTH, dirDepth(root)); d >= 1; d--) {
    const acc: string[] = [];
    mapLines(root, d, "", acc);
    lines = acc;
    depth = d;
    if (Buffer.byteLength(neutralizeMarkers(acc.join("\n")), "utf8") <= MAP_MAX_BYTES) break;
  }
  if (lines.length === 0) {
    return { text: null, files: root.total, dirs, depth: 0, rootFiles: root.files.length, truncated: false };
  }
  const cut = truncateAtLine(neutralizeMarkers(lines.join("\n")), MAP_MAX_BYTES);
  const text = cut.truncated
    ? `${cut.text}\n…（目录过多已截断，其余目录见完整目录或 ls 定位）`
    : cut.text;
  return { text, files: root.total, dirs, depth, rootFiles: root.files.length, truncated: cut.truncated };
}

/**
 * 生成托管区块正文（含起止标记）：只放每次会话都需要的东西——知识库位置、
 * 何时查、怎么查、只读约束与目录地图。写入流程、沉淀标准与完整文件清单
 * 都在内置 skill（KB_SKILL_NAME）里，按需加载。
 *
 * map 传 null / undefined（或无文件）时输出回退文案（知识库暂无文件的情况）。
 */
export function buildBlock(dir: string, map?: KbMap | null): string {
  const hasMap = map != null && map.files > 0;
  const mapSection = !hasMap
    ? `知识库暂无文件，需要时直接 rg 全库。`
    : map.text
      ? `### 目录地图（目录/（篇数），展开到第 ${map.depth} 层，共 ${map.files} 篇）

${map.text}${map.rootFiles > 0 ? `\n（根目录另有 ${map.rootFiles} 篇）` : ""}`
      : `共 ${map.files} 篇，均在根目录下。`;

  return `${BLOCK_START}
## 组织知识库（knowbase · 飞书镜像）

\`${dir}\` 是飞书知识库的**只读本地镜像**，全组织共享，后台自动单向同步；文件名即飞书文档标题。

- **何时查**：涉及业务背景、历史决策、架构约定、环境与服务配置、踩坑记录、跨项目约定等组织知识时，先查知识库再回答或动手。
- **怎么查**：先按下方地图定位目录，再用 \`rg\` 搜全文和文件名；完整文件清单与检索方法在 skill \`${KB_SKILL_NAME}\`。**说「知识库里没有」之前**，必须用中英文、同义词各搜一轮全文和文件名。
- **只读**：不要编辑本目录任何文件（已设只读，改动会被下个同步周期丢弃）。要修改或新增知识，先加载 skill \`${KB_SKILL_NAME}\`，按其中的写入流程走飞书。
- **团队 skill**：本机 \`${ORG_PREFIX}<name>\` 系列 skill 由知识库 \`${SKILLS_SUBDIR}/\` 目录分发。

${mapSection}
${BLOCK_END}`;
}

/**
 * 用新区块替换旧区块；无旧区块则追加到文末。返回处理后的完整内容。
 *
 * 返回 null 表示「有起始标记但没有结束标记」——无法安全定位区块边界，调用方
 * 应跳过该文件。这是本函数唯一的失败模式：改为守护进程每周期都写之后，任何
 * 第三方非原子写入（另一个 dotfile 工具、编辑器崩溃、agent 编辑 CLAUDE.md）
 * 都可能留下这种半截状态；若按「从起始处替换到文末」修补，会永久删掉标记
 * 之后的全部用户内容。
 */
export function upsertBlock(content: string, block: string): string | null {
  const startIdx = content.indexOf(BLOCK_START);
  if (startIdx !== -1) {
    const endMarker = content.indexOf(BLOCK_END, startIdx);
    if (endMarker !== -1) {
      const endIdx = endMarker + BLOCK_END.length;
      return content.slice(0, startIdx) + block + content.slice(endIdx);
    }
    return null;
  }
  if (content.trim() === "") return block + "\n";
  const sep = content.endsWith("\n") ? "\n" : "\n\n";
  return content + sep + block + "\n";
}

/** 从内容中移除托管区块（含前导空白），返回处理后的内容与是否发生移除。 */
export function stripBlock(content: string): { content: string; removed: boolean } {
  const startIdx = content.indexOf(BLOCK_START);
  if (startIdx === -1) return { content, removed: false };
  const endMarker = content.indexOf(BLOCK_END, startIdx);
  const endIdx =
    endMarker === -1 ? content.length : endMarker + BLOCK_END.length;
  // 连同区块前的空白一起吃掉，避免留下空行堆积
  let before = content.slice(0, startIdx).replace(/\s+$/, "");
  let after = content.slice(endIdx).replace(/^\s*\n/, "");
  let result = before;
  if (after.length > 0) result += (before.length > 0 ? "\n\n" : "") + after;
  if (result.length > 0 && !result.endsWith("\n")) result += "\n";
  return { content: result, removed: true };
}

export interface AgentConfigChange {
  name: string;
  file: string;
  /**
   * created=新建文件；updated=更新区块；unchanged=已是最新（或按 onlyExisting 跳过）；
   * skipped=区块残缺无法安全写入，已放弃
   */
  action: "created" | "updated" | "unchanged" | "skipped";
  reason?: string;
}

/** syncAgentConfig 的可选行为。 */
export interface SyncAgentConfigOptions {
  hermesHome?: string;
  /** 本机配置了飞书写入应用：提示词引导 agent 用应用身份写知识库。 */
  larkWriteApp?: boolean;
  /**
   * 只刷新已存在的区块，绝不创建。守护进程用；init 不用。
   * 用户手动删掉区块、或当年用 --no-agent-config 接入（配置里没有该键、被
   * loadConfig 当成默认开启）时，后台不该把区块重新塞回个人提示词文件。
   */
  onlyExisting?: boolean;
}

/** 软链逐跳解析的上限，防御成环的软链。 */
const MAX_LINK_HOPS = 8;

/**
 * 解析出真正该写入的路径。
 * 常规情况（文件存在、或软链的目标存在）由 realpathSync 一次解析到底，链式软链
 * 也能完整走通。realpathSync 解析不了「悬空软链」——链在、目标文件还没建——但
 * 那种链同样必须保住：直接 rename 会把链换成普通文件，仓库副本永远不会被创建。
 * 于是退化为逐跳 readlink，走到第一个不是软链的位置。
 */
function resolveWriteTarget(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    let cur = file;
    for (let i = 0; i < MAX_LINK_HOPS; i++) {
      const st = fs.lstatSync(cur, { throwIfNoEntry: false });
      if (!st?.isSymbolicLink()) return cur;
      cur = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
    }
    return cur;
  }
}

/**
 * 原子写入：真实文件同目录临时文件 + rename。
 * 这些是用户的个人提示词文件，改为每个同步周期都可能触发的周期性写入后，
 * 进程在错误时机被 kill 会留下截断的 CLAUDE.md，损坏代价高。
 */
export function writeFileAtomic(file: string, content: string): void {
  // 先解析真实路径：dotfiles 仓库常把 ~/.claude/CLAUDE.md 做成指向仓库副本的
  // 软链。renameSync 不跟随软链，会 unlink 掉软链、换上一个普通文件——仓库副本
  // 从此静默失联，用户之后在仓库里的手改对 agent 完全不可见，且毫无提示。
  // 解析后写真实文件，既保住软链，也保证 rename 始终同目录、同文件系统（软链
  // 跨卷是唯一会引发 EXDEV 的情况）。
  const target = resolveWriteTarget(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 临时名带 pid：守护进程的周期刷新与用户手跑的 init 会同时写同一个目标文件，
  // 共用一个固定临时名会让两个进程交错写入同一临时文件再各自 rename，产出的
  // 正是原子写本来要防的那种交错损坏内容。
  const tmp = `${target}.knowbase-tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, target);
  } catch (e) {
    // 失败时残留的临时文件会永久留在 ~/.claude/ 下；清理本身失败不能掩盖原始错误。
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw e;
  }
}

/**
 * 把托管区块（含知识库目录树快照）写入所有 agent 全局提示词文件。
 * init 与守护进程每个同步周期共用此函数；内容与现状相同则不落盘。
 */
export function syncAgentConfig(
  dir: string,
  home: string = os.homedir(),
  opts: SyncAgentConfigOptions = {}
): AgentConfigChange[] {
  const block = buildBlock(dir, readKbMap(dir));
  const changes: AgentConfigChange[] = [];
  for (const t of agentTargets(home)) {
    const existed = fs.existsSync(t.file);
    // 读取用原路径：读操作穿透软链，语义正确。
    const prev = existed ? fs.readFileSync(t.file, "utf8") : "";
    if (opts.onlyExisting && !prev.includes(BLOCK_START)) {
      changes.push({ name: t.name, file: t.file, action: "unchanged" });
      continue;
    }
    const next = upsertBlock(prev, block);
    if (next === null) {
      changes.push({ name: t.name, file: t.file, action: "skipped" });
      continue;
    }
    if (next === prev) {
      changes.push({ name: t.name, file: t.file, action: "unchanged" });
      continue;
    }
    writeFileAtomic(t.file, next);
    changes.push({
      name: t.name,
      file: t.file,
      action: existed ? "updated" : "created",
    });
  }
  return [...changes, ...syncAdditionalAgentConfig(block, home, opts.onlyExisting, opts.hermesHome)];
}

export interface AgentConfigRemoval {
  name: string;
  file: string;
  removed: boolean;
  error?: string;
}

/** uninstall 时调用：从所有 agent 全局提示词文件移除托管区块。 */
export function uninstallAgentConfig(
  home: string = os.homedir(), hermesHome?: string
): AgentConfigRemoval[] {
  const removals: AgentConfigRemoval[] = [];
  for (const t of agentTargets(home)) {
    if (!fs.existsSync(t.file)) {
      removals.push({ name: t.name, file: t.file, removed: false });
      continue;
    }
    const prev = fs.readFileSync(t.file, "utf8");
    const { content, removed } = stripBlock(prev);
    if (removed) fs.writeFileSync(t.file, content, "utf8");
    removals.push({ name: t.name, file: t.file, removed });
  }
  return [...removals, ...uninstallAdditionalAgentConfig(home, hermesHome)];
}
