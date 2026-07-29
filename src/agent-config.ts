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

/** 生成托管区块正文（含起止标记），内嵌本机知识库目录。 */
export function buildBlock(dir: string): string {
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

/** init 时调用：把托管区块写入所有 agent 全局提示词文件。 */
export function installAgentConfig(
  dir: string,
  home: string = os.homedir()
): AgentConfigChange[] {
  const block = buildBlock(dir);
  const changes: AgentConfigChange[] = [];
  for (const t of agentTargets(home)) {
    const existed = fs.existsSync(t.file);
    const prev = existed ? fs.readFileSync(t.file, "utf8") : "";
    const next = upsertBlock(prev, block);
    if (next === prev) {
      changes.push({ name: t.name, file: t.file, action: "unchanged" });
      continue;
    }
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(t.file, next, "utf8");
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
