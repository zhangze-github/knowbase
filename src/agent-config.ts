import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ORG_PREFIX, SKILLS_SUBDIR } from "./skills-sync.js";

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

/** 索引文件的规范名。查找时大小写不敏感。 */
export const INDEX_NAME = "index.md";

/** 内嵌索引的字节上限（约 2k token）。索引长起来会静默吃掉每次会话的上下文预算。 */
export const INDEX_MAX_BYTES = 8192;

/**
 * 从目录条目名中挑出索引文件名，大小写不敏感。
 *
 * APFS 默认大小写不敏感、Linux 敏感：按字面 index.md 查找会导致仓库里存在
 * Index.md 时「macOS 上索引生效、Linux 上索引缺失」的跨平台不一致。
 *
 * 写成接受条目名数组的纯函数，是因为「多个大小写变体并存」在大小写不敏感的
 * 文件系统上无法落盘构造，只能这样测。
 */
export function pickIndexName(entries: string[]): string | null {
  const matches = entries.filter((e) => e.toLowerCase() === INDEX_NAME);
  if (matches.length === 0) return null;
  if (matches.includes(INDEX_NAME)) return INDEX_NAME;
  return [...matches].sort()[0];
}

/**
 * 中和索引正文中的区块标记字样。
 *
 * 索引由外部 agent 生成，正文里完全可能出现 KNOWBASE:END（例如索引记录了
 * knowbase 自身的文档）。若原样内嵌，upsertBlock / stripBlock 会匹配到提前
 * 出现的结束标记、切错位置，吞掉用户 CLAUDE.md 中区块之后的内容。
 */
export function neutralizeMarkers(text: string): string {
  return text.replace(/KNOWBASE:(START|END)/g, "KNOWBASE_$1");
}

/** 按字节上限截断，切点落在不超限的最后一个换行处。 */
function truncateAtLine(text: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, truncated: false };
  const head = buf.subarray(0, max).toString("utf8");
  const cut = head.lastIndexOf("\n");
  // 无换行可切（单行超长）时退化为按字符切，并去掉多字节字符被切断产生的替换符
  // cut > 0 而非 >= 0 是有意为之：换行落在下标 0 会切出空正文，不如落到下面的字节级兜底
  const kept = cut > 0 ? head.slice(0, cut) : head.replace(/�+$/, "");
  return { text: kept, truncated: true };
}

export interface IndexResult {
  /** 实际命中的文件名（如 index.md / Index.md）；未找到为 null。 */
  name: string | null;
  /** 规范化后可直接内嵌的正文；未找到为 null。 */
  text: string | null;
  /** 索引文件原始字节数（供 status 展示）。 */
  bytes: number;
  /** 是否因超过 INDEX_MAX_BYTES 被截断。 */
  truncated: boolean;
}

// 冻结：这是被多条路径按引用返回的共享单例，任何调用方顺手改一个字段都会污染
// 后续所有调用。冻结把这种静默污染变成立即的 TypeError。
const EMPTY_INDEX: IndexResult = Object.freeze({
  name: null,
  text: null,
  bytes: 0,
  truncated: false,
});

/**
 * 读取知识库根索引并规范化为可内嵌的正文。
 * 目录不存在 / 无索引 / 读取失败一律返回空结果，绝不抛错——
 * 索引维护 agent 尚未跑起来时 init 不该失败。
 */
export function readIndex(dir: string): IndexResult {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return EMPTY_INDEX;
  }
  const name = pickIndexName(entries);
  if (!name) return EMPTY_INDEX;

  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, name), "utf8");
  } catch {
    return EMPTY_INDEX;
  }

  const bytes = Buffer.byteLength(raw, "utf8");
  const cut = truncateAtLine(neutralizeMarkers(raw), INDEX_MAX_BYTES);
  const text = cut.truncated
    ? `${cut.text}\n\n…（索引过长已截断，完整内容见 \`${path.join(dir, name)}\`）`
    : cut.text;
  return { name, text, bytes, truncated: cut.truncated };
}

/**
 * 生成托管区块正文（含起止标记），内嵌本机知识库目录与根索引快照。
 * index 传 null / undefined 时输出回退文案（索引维护 agent 还没跑起来的情况）。
 */
export function buildBlock(dir: string, index?: string | null): string {
  // 纯空白的索引（含零字节文件）也走回退文案：否则会输出一个有标题没正文的
  // 段落，且与 status 「存在但为空」的口径打架。
  const hasIndex = index != null && index.trim() !== "";
  const indexSection = hasIndex
    ? `### 知识库索引（根 ${INDEX_NAME} 快照，由 knowbase 自动同步）

${index}`
    : `根目录暂无 \`${INDEX_NAME}\`，需要时直接 grep 全库。`;

  return `${BLOCK_START}
## 组织知识库（knowbase）

\`${dir}\` —— **全组织共享**，后台自动与 Git 远端双向同步，你写入的内容会同步给所有成员。

**读**：需要业务背景、历史决策、架构约定、环境配置、踩坑记录等组织隐性知识时，先 grep / 读该目录下的 Markdown。

**写**：只写对其他成员有复用价值的组织级知识；拿不准先询问用户，不要擅自写入。
- ✅ 业务规则与背景、技术决策及其原因、公共环境/服务配置、通用踩坑与解决方案、跨项目约定。
- ❌ 个人偏好与习惯、个人待办/日程/草稿、仅与本机或当前个人任务相关的内容、个人私人信息——放本机个人配置或个人笔记，不进知识库。

**沉淀可执行流程**：知识库不只放散文。把「怎么做某件事」的步骤沉淀成 skill —— 写到 \`${dir}/${SKILLS_SUBDIR}/<name>/SKILL.md\`（需含 \`name\` / \`description\` 的 YAML frontmatter），knowbase 会自动分发到全团队每个人的 Claude Code。本机以 \`${ORG_PREFIX}<name>\` 出现；skill 之间互相引用时用带前缀的全名。

**操作**：直接读写 Markdown，保存即同步，无需 git add/commit/push。大范围改动前 \`knowbase pause\`，完成后 \`knowbase resume\`。

**导航**：每个目录下的 \`${INDEX_NAME}\` 是该目录索引（文件名大小写不敏感）。进子目录前先读它；增删文件后顺手更新它。

${indexSection}
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
}

/** syncAgentConfig 的可选行为。 */
export interface SyncAgentConfigOptions {
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
function writeFileAtomic(file: string, content: string): void {
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
 * 把托管区块（含知识库根索引快照）写入所有 agent 全局提示词文件。
 * init 与守护进程每个同步周期共用此函数；内容与现状相同则不落盘。
 */
export function syncAgentConfig(
  dir: string,
  home: string = os.homedir(),
  opts: SyncAgentConfigOptions = {}
): AgentConfigChange[] {
  const block = buildBlock(dir, readIndex(dir).text);
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
  return changes;
}

export interface AgentConfigRemoval {
  name: string;
  file: string;
  removed: boolean;
}

/** uninstall 时调用：从所有 agent 全局提示词文件移除托管区块。 */
export function uninstallAgentConfig(
  home: string = os.homedir()
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
  return removals;
}
