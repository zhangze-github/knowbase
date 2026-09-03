import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ORG_PREFIX, SKILLS_SUBDIR } from "./skills-sync.js";
import { isMirrorMode, readMirrorManifest } from "./mirror.js";

/**
 * 把知识库集成片段写入各 AI agent 的全局提示词文件，使 agent 天然知道
 * 「组织知识库在哪、怎么读写」。用带标记的托管区块实现，幂等且可逆，
 * 不影响用户在同一文件中的其他内容。
 */

export const BLOCK_START = "<!-- KNOWBASE:START （由 knowbase 自动管理，勿手动编辑本区块） -->";
export const BLOCK_END = "<!-- KNOWBASE:END -->";

/** 镜像模式注入区块所需信息（spec §5）。 */
export interface MirrorBlockInfo {
  /** 「Agent 沉淀」目录的飞书 wiki URL；exporter 侧未配置时缺失。 */
  inboxUrl?: string;
}

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

/** 注入目录树的字节上限（约 2k token）。树长起来会静默吃掉每次会话的上下文预算。 */
export const TREE_MAX_BYTES = 8192;

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

export interface KbTree {
  /** 可直接内嵌的树文本；知识库无文件时为 null。 */
  text: string | null;
  /** 文件总数（不含被跳过的条目）。 */
  files: number;
  /** 完整树文本的原始字节数（截断前，供 status 展示）。 */
  bytes: number;
  truncated: boolean;
}

/**
 * 递归列出一层目录下的行：目录先于文件、各自按默认字符串排序，保证
 * 跨平台（不同文件系统的 readdir 顺序不保证一致）确定性输出。
 * 跳过点开头的条目（.git、.knowbase-mirror.json、.gitignore、
 * .knowbase-pause 等 knowbase/git 自身的管理文件）与 node_modules——
 * 这些对 agent 定位知识没有意义，混进树里只会稀释信噪比。
 * 任意一层 readdir 失败（目录不存在、权限问题等）当作空，不向上抛。
 */
function listTree(dir: string, indent: string, acc: string[], counter: { files: number }): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const visible = entries.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules");
  const dirs = visible.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const files = visible.filter((e) => !e.isDirectory()).map((e) => e.name).sort();
  for (const name of dirs) {
    acc.push(`${indent}${name}/`);
    listTree(path.join(dir, name), indent + "  ", acc, counter);
  }
  for (const name of files) {
    acc.push(`${indent}${name}`);
    counter.files++;
  }
}

/**
 * 生成知识库目录树，替代旧的「根 index.md 快照」注入。
 *
 * 为什么用自动生成的树取代 index.md：index.md 要人（或专门的索引维护 agent）
 * 持续手改才不过期，团队实践下来经常是「建了一次、之后再没更新过」；目录树
 * 由 knowbase 每个同步周期直接扫描文件系统生成，零维护、永不过期。镜像模式下
 * 文件名本身就是飞书文档标题（见 spec §9），是天然的语义索引，树上一眼就能
 * 看出「哪篇文档在哪」，agent 不需要再多一层人工索引就能按路径定位文件。
 *
 * 目录不存在 / 读取失败一律返回空结果，绝不抛错——daemon 路径不能因为
 * 知识库目录一时不可读就崩掉。
 */
export function readKbTree(dir: string): KbTree {
  const lines: string[] = [];
  const counter = { files: 0 };
  listTree(dir, "", lines, counter);
  if (lines.length === 0) {
    return { text: null, files: 0, bytes: 0, truncated: false };
  }
  const raw = lines.join("\n");
  const bytes = Buffer.byteLength(raw, "utf8");
  const cut = truncateAtLine(neutralizeMarkers(raw), TREE_MAX_BYTES);
  const text = cut.truncated
    ? `${cut.text}\n\n…（目录树过长已截断，其余文件直接 grep 全库定位）`
    : cut.text;
  return { text, files: counter.files, bytes, truncated: cut.truncated };
}

/**
 * 生成托管区块正文（含起止标记），内嵌本机知识库目录与自动生成的目录树。
 * tree 传 null / undefined（或纯空白）时输出回退文案（知识库暂无文件的情况）。
 * mirror 传 null / undefined 时输出经典文案；非 null 时切换为镜像模式文案（spec §5）。
 */
export function buildBlock(
  dir: string,
  tree?: string | null,
  mirror?: MirrorBlockInfo | null
): string {
  // 纯空白的树（知识库确实没有文件）也走回退文案：否则会输出一个有标题没正文的
  // 段落，且与 status 「暂无文件」的口径打架。
  const hasTree = tree != null && tree.trim() !== "";
  const treeSection = hasTree
    ? `### 知识库目录树（全部文件，由 knowbase 自动生成）

${tree}`
    : `知识库暂无文件，需要时直接 grep 全库。`;

  if (mirror) {
    const inbox = mirror.inboxUrl
      ? `：${mirror.inboxUrl}`
      : "（沉淀目录 URL 未配置，请询问用户）";
    return `${BLOCK_START}
## 组织知识库（knowbase · 飞书镜像）

\`${dir}\` —— 飞书知识库的**只读本地镜像**，全组织共享，后台自动从飞书单向同步。

**读**：需要业务背景、历史决策、架构约定、环境配置、踩坑记录等组织隐性知识时，先 grep / 读该目录下的 Markdown。

**写（重要，本目录只读）**：
- 禁止直接编辑本目录任何文件——文件已设只读，写入会失败；绕过锁写入的内容也会在下个同步周期被自动丢弃。
- 要修改某篇知识：取该文件头部 frontmatter 的 \`feishu_url\`，用飞书文档工具（lark-doc）编辑对应飞书文档。
- 编辑前先用 lark-doc 读取该文档的最新内容——本地镜像可能落后几分钟，不要基于旧版整篇覆盖。
- 要新增知识：用 lark-wiki 在「Agent 沉淀」目录下创建文档${inbox}。
- 修改会在几分钟内自动回流到本目录；同一会话内如需引用刚写入的内容，以写进飞书的版本为准。

**团队 skill**：\`${SKILLS_SUBDIR}/\` 目录不走飞书，通过知识库 git 仓库提 PR 维护（需含 \`name\` / \`description\` frontmatter），knowbase 自动分发到全团队，本机以 \`${ORG_PREFIX}<name>\` 出现。

**导航**：下方目录树是全库实时地图（每周期自动刷新，文件名即主题）；先在树中定位文件路径再读取，树被截断或找不到时 grep 全库。

${treeSection}
${BLOCK_END}`;
  }

  return `${BLOCK_START}
## 组织知识库（knowbase）

\`${dir}\` —— **全组织共享**，后台自动与 Git 远端双向同步，你写入的内容会同步给所有成员。

**读**：需要业务背景、历史决策、架构约定、环境配置、踩坑记录等组织隐性知识时，先 grep / 读该目录下的 Markdown。

**写**：只写对其他成员有复用价值的组织级知识；拿不准先询问用户，不要擅自写入。
- ✅ 业务规则与背景、技术决策及其原因、公共环境/服务配置、通用踩坑与解决方案、跨项目约定。
- ❌ 个人偏好与习惯、个人待办/日程/草稿、仅与本机或当前个人任务相关的内容、个人私人信息——放本机个人配置或个人笔记，不进知识库。

**沉淀可执行流程**：知识库不只放散文。把「怎么做某件事」的步骤沉淀成 skill —— 写到 \`${dir}/${SKILLS_SUBDIR}/<name>/SKILL.md\`（需含 \`name\` / \`description\` 的 YAML frontmatter），knowbase 会自动分发到全团队每个人的 Claude Code。本机以 \`${ORG_PREFIX}<name>\` 出现；skill 之间互相引用时用带前缀的全名。

**操作**：直接读写 Markdown，保存即同步，无需 git add/commit/push。大范围改动前 \`knowbase pause\`，完成后 \`knowbase resume\`。

**导航**：下方目录树是全库实时地图（每周期自动刷新，文件名即主题）；先在树中定位文件路径再读取，树被截断或找不到时 grep 全库。

${treeSection}
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
 * 把托管区块（含知识库目录树快照）写入所有 agent 全局提示词文件。
 * init 与守护进程每个同步周期共用此函数；内容与现状相同则不落盘。
 */
export function syncAgentConfig(
  dir: string,
  home: string = os.homedir(),
  opts: SyncAgentConfigOptions = {}
): AgentConfigChange[] {
  // 镜像仓库自动切换文案（spec §5）；清单损坏时 manifest 为 null，
  // 仍走镜像文案（只是没有沉淀目录 URL）——见 isMirrorMode 的注释
  const mirror = isMirrorMode(dir)
    ? { inboxUrl: readMirrorManifest(dir)?.agent_inbox_url }
    : null;
  const block = buildBlock(dir, readKbTree(dir).text, mirror);
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
