import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const EMPTY_INDEX: IndexResult = { name: null, text: null, bytes: 0, truncated: false };

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
  const indexSection = index
    ? `### 知识库索引（根 ${INDEX_NAME} 快照，由 knowbase 自动同步）

${index}`
    : `根目录暂无 \`${INDEX_NAME}\`，需要时直接 grep 全库。`;

  return `${BLOCK_START}
## 组织知识库（knowbase）

本机知识库位于：\`${dir}\`
这是**全组织共享**的知识库：一个由 knowbase 后台自动与 Git 远端双向同步的文件夹，你写入的任何内容都会同步给团队所有成员。

**读**：需要组织的业务背景、历史决策、架构约定、环境配置、踩坑记录等隐性知识时，优先 grep / 读取该目录下的 Markdown。

**写**：只沉淀「对团队其他成员有复用价值」的组织级知识，写入前先自问：换一个同事看到这条，是否有用？
- ✅ 该写入：业务规则与背景、技术决策及其原因、公共环境/服务配置、通用踩坑与解决方案、跨项目约定。
- ❌ 禁止写入：用户的个人偏好与习惯、个人待办/日程/草稿、只与当前这台机器或当前个人任务相关的内容、任何私人信息（姓名/账号/密钥/个人路径等）。这类内容应放在本机的个人配置（如 \`~/.claude/CLAUDE.md\`）或个人笔记里，绝不进入知识库。
- 拿不准是否属于组织知识时，先询问用户，不要擅自写入。

**操作**：直接在该目录写入 / 编辑 Markdown 即可，保存即同步，无需 git add/commit/push。大范围改动前先运行 \`knowbase pause\`，完成后 \`knowbase resume\`。

**导航**：知识库每个目录下都有 \`${INDEX_NAME}\` 作为该目录的索引（文件名大小写不敏感）。进入任一子目录查找前，先读该目录的 \`${INDEX_NAME}\`；在知识库中新增或删除文件后，顺手更新所在目录的 \`${INDEX_NAME}\`。

${indexSection}
${BLOCK_END}`;
}

/** 用新区块替换旧区块；无旧区块则追加到文末。返回处理后的完整内容。 */
export function upsertBlock(content: string, block: string): string {
  const startIdx = content.indexOf(BLOCK_START);
  if (startIdx !== -1) {
    const endMarker = content.indexOf(BLOCK_END, startIdx);
    if (endMarker !== -1) {
      const endIdx = endMarker + BLOCK_END.length;
      return content.slice(0, startIdx) + block + content.slice(endIdx);
    }
    // 有起始无结束（异常/被截断）：从起始处起全部替换
    return content.slice(0, startIdx) + block + "\n";
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
  /** created=新建文件；updated=更新区块；unchanged=已是最新 */
  action: "created" | "updated" | "unchanged";
}

/**
 * 原子写入：同目录临时文件 + rename。
 * 这些是用户的个人提示词文件，改为每个同步周期都可能触发的周期性写入后，
 * 进程在错误时机被 kill 会留下截断的 CLAUDE.md，损坏代价高。
 */
function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.knowbase-tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * 把托管区块（含知识库根索引快照）写入所有 agent 全局提示词文件。
 * init 与守护进程每个同步周期共用此函数；内容与现状相同则不落盘。
 */
export function syncAgentConfig(
  dir: string,
  home: string = os.homedir()
): AgentConfigChange[] {
  const block = buildBlock(dir, readIndex(dir).text);
  const changes: AgentConfigChange[] = [];
  for (const t of agentTargets(home)) {
    const existed = fs.existsSync(t.file);
    const prev = existed ? fs.readFileSync(t.file, "utf8") : "";
    const next = upsertBlock(prev, block);
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
