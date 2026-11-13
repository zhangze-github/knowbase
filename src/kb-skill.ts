import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { KB_SKILL_NAME, neutralizeMarkers, scanKb, type KbDirNode } from "./agent-config.js";
import { hashSkillDir, MARKER_NAME, ORG_PREFIX, SKILLS_SUBDIR, skillTargets, TMP_SUFFIX } from "./skills-sync.js";
import { additionalAgentHomes } from "./agent-installations.js";
import { LARK_WRITE_PROFILE } from "./lark-write-app.js";

/**
 * 内置 skill `knowbase`：常驻区块之外的全部知识库说明——完整文件目录、检索
 * 方法、写入流程、沉淀标准、团队 skill 维护方式。
 *
 * 为什么放进 skill：这些内容只在「要找具体文档」或「要写知识库」时才用得上，
 * 常驻会让每次会话都付出上下文成本（且文件清单随文档数线性增长）。skill 平时只有
 * name + description 进上下文，正文与 references/ 按需读取。
 *
 * 与团队 skills（skills-sync.ts）的关系：分发目标相同（skillTargets），但目录名
 * 不带 org- 前缀，团队 skill 同步只扫描 org-* 条目，两者互不干扰。所有权靠目录内
 * 的标记文件（kind = builtin）认定；同名但不是我们建的目录一律不碰。
 */

/** 完整目录超过这个字节数就按顶层目录拆成多个文件，单个文件保持可一次读完。 */
export const CATALOG_SPLIT_BYTES = 48 * 1024;

const MARKER_KIND = "builtin";

interface KbSkillMarker {
  kind: typeof MARKER_KIND;
  /** 生成内容的哈希。 */
  hash: string;
  /** 落盘时副本自身的内容哈希（不含标记文件），用于检测本机手改。 */
  copyHash: string;
  syncedAt: string;
}

function treeLines(node: KbDirNode, indent: string, acc: string[]): void {
  for (const d of node.dirs) {
    acc.push(`${indent}${d.name}/`);
    treeLines(d, indent + "  ", acc);
  }
  for (const f of node.files) acc.push(`${indent}${f}`);
}

function catalogHeader(dir: string, title: string, files: number): string {
  return `# ${title}

知识库根目录：\`${dir}\`（共 ${files} 篇，由 knowbase 每个同步周期自动生成，勿手改）。
下方是完整文件树：缩进两格表示下一层，目录带 / 后缀，路径 = 根目录 + 各层名字拼接。
`;
}

/**
 * 生成完整目录文件（相对 skill 根目录的路径 → 内容）。
 * 不折叠、不截断：这里就是「全集」，agent 在这里找不到才该怀疑库里没有。
 */
export function buildCatalog(dir: string, root: KbDirNode = scanKb(dir)): Record<string, string> {
  const all: string[] = [];
  treeLines(root, "", all);
  const single = `${catalogHeader(dir, "知识库完整目录", root.total)}
${neutralizeMarkers(all.join("\n"))}
`;
  if (Buffer.byteLength(single, "utf8") <= CATALOG_SPLIT_BYTES || root.dirs.length === 0) {
    return { "references/catalog.md": single };
  }
  // 过大时按顶层目录拆分（Mintlify 的做法：根索引指向子文件），根文件只列分片
  // 与根目录直属文件，保证每个文件都能一次读完。
  const out: Record<string, string> = {};
  const index: string[] = [];
  root.dirs.forEach((d, i) => {
    const file = `references/catalog-${String(i + 1).padStart(2, "0")}.md`;
    const lines: string[] = [`${d.name}/`];
    treeLines(d, "  ", lines);
    out[file] = `${catalogHeader(dir, `知识库目录：${d.name}/`, d.total)}
${neutralizeMarkers(lines.join("\n"))}
`;
    index.push(`- \`${d.name}/\`（${d.total} 篇）→ ${path.posix.basename(file)}`);
  });
  const rootFiles = root.files.length > 0
    ? `\n\n## 根目录直属文件\n\n${neutralizeMarkers(root.files.join("\n"))}`
    : "";
  out["references/catalog.md"] = `${catalogHeader(dir, "知识库完整目录（索引）", root.total)}
目录较大，已按顶层目录拆分。先在这里选分片，再读对应文件：

${neutralizeMarkers(index.join("\n"))}${rootFiles}
`;
  return out;
}

/** SKILL.md 正文。dir 进 description，agent 判断是否触发时就知道知识库在哪。 */
export function buildSkillMd(dir: string, files: number, larkWriteApp = false): string {
  const description =
    `组织知识库（${dir}，飞书知识库的只读本地镜像）的完整文件目录、检索方法与写入流程。` +
    `查找业务背景、历史决策、架构约定、环境与服务配置、踩坑记录等组织知识，` +
    `或要修改、新增、沉淀知识库内容时使用。`;
  const writeIdentity = larkWriteApp
    ? `- **写入身份：本机用飞书应用身份操作知识库**。调用 lark-cli 操作知识库文档时（含读取最新内容）一律带 \`--profile ${LARK_WRITE_PROFILE} --as bot\`；本条优先于 lark-doc / lark-wiki 中「优先用 user 身份」的说明，不要用 \`--as user\`，也不要发起 \`auth login\`。权限不足时如实告知用户（应用须是知识库的可编辑成员），不要换身份重试。应用没有个人文档库，新建文档必须显式指定 \`--parent-node-token\`（可用目标目录文档的 \`feishu_url\` 通过 \`wiki +node-get\` 解析）。
`
    : "";
  // description 用 JSON 字符串写：它是合法的 YAML 双引号标量，路径里出现 `: ` 等
  // YAML 特殊字符也不会把 frontmatter 弄坏。
  return `---
name: ${KB_SKILL_NAME}
description: ${JSON.stringify(description)}
---

# 组织知识库（knowbase · 飞书镜像）

\`${dir}\` 是飞书知识库的**只读本地镜像**（共 ${files} 篇），全组织共享，后台自动从飞书单向同步。文件名即飞书文档标题；每篇文件头的 frontmatter 含 \`feishu_url\`（飞书原文地址）、\`title\`、\`synced_at\`（最近同步时间）。

## 查找

1. 读 [references/catalog.md](references/catalog.md)：完整文件目录（全集，不折叠），按标题定位路径。
2. 用 \`rg\` 搜文件名和全文：
   - 文件名：\`rg --files ${shellQuote(dir)} | rg -i '关键词'\`
   - 全文：\`rg -i -l '关键词' ${shellQuote(dir)}\`，再读命中的文件。
3. **说「知识库里没有」之前**：中文、英文、同义词、缩写、产品或服务代号各搜一轮全文和文件名，并在目录里核对相近主题的文档。仍没找到时，如实说明搜过哪些词。
4. 引用知识时给出文件路径；需要原文链接时取 frontmatter 的 \`feishu_url\`。

## 写入（本目录只读，写入走飞书）

${writeIdentity}- 禁止直接编辑本目录任何文件——文件已设只读，写入会失败；绕过锁写入的内容也会在下个同步周期被自动丢弃。
- 要修改某篇知识：取该文件头部 frontmatter 的 \`feishu_url\`，用飞书文档工具（lark-doc）编辑对应飞书文档。
- 编辑前先用 lark-doc 读取该文档的最新内容——本地镜像可能落后几分钟，不要基于旧版整篇覆盖。
- 要新增知识：优先补充进已有的相关文档；确需新文档时，用 lark-wiki 创建，并参照完整目录自行判断挂到哪个节点下最合适。你的编辑与人类成员完全平权，没有专属 AI 的目录。
- 修改会在几分钟内自动回流到本目录；同一会话内如需引用刚写入的内容，以写进飞书的版本为准。

## 沉淀标准

只沉淀对整个组织/团队有复用价值的内容：业务规则与背景、技术决策及其原因、公共环境/服务配置、通用踩坑与解决方案、跨项目约定。个人偏好与习惯、个人待办/日程/草稿、仅与本机或当前个人任务相关的内容、个人隐私信息——一律不进知识库；拿不准先询问用户。

## 团队 skill

知识库 \`${SKILLS_SUBDIR}/\` 目录不走飞书，通过知识库 git 仓库提 PR 维护（每个 skill 一个子目录，\`SKILL.md\` 需含 \`name\` / \`description\` frontmatter）。knowbase 自动分发到全团队，本机以 \`${ORG_PREFIX}<name>\` 出现；在本机副本里手改不会回写，下个同步周期会被覆盖。
`;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./~-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** 生成整个 skill 的文件集合（相对路径 → 内容），不含标记文件。 */
export function buildKbSkillFiles(dir: string, larkWriteApp = false): Record<string, string> {
  const root = scanKb(dir);
  return {
    "SKILL.md": buildSkillMd(dir, root.total, larkWriteApp),
    ...buildCatalog(dir, root),
  };
}

function hashFiles(files: Record<string, string>): string {
  const h = crypto.createHash("sha256");
  for (const rel of Object.keys(files).sort()) {
    h.update(rel, "utf8");
    h.update("\0");
    h.update(files[rel], "utf8");
    h.update("\0");
  }
  return h.digest("hex");
}

function readMarker(dir: string): KbSkillMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER_NAME), "utf8"));
    if (!m || m.kind !== MARKER_KIND || typeof m.hash !== "string") return null;
    return m as KbSkillMarker;
  } catch {
    return null;
  }
}

function copyHash(dir: string): string | null {
  try {
    return hashSkillDir(dir, [MARKER_NAME]);
  } catch {
    return null;
  }
}

/** 临时目录 + rename 整体替换，避免半个 skill 被客户端加载。 */
function install(skillsHome: string, files: Record<string, string>, hash: string): void {
  const finalDir = path.join(skillsHome, KB_SKILL_NAME);
  const tmp = `${finalDir}${TMP_SUFFIX}${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const [rel, content] of Object.entries(files)) {
      const to = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, content, "utf8");
    }
    const marker: KbSkillMarker = {
      kind: MARKER_KIND,
      hash,
      copyHash: hashSkillDir(tmp, [MARKER_NAME]),
      syncedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tmp, MARKER_NAME), JSON.stringify(marker, null, 2) + "\n", "utf8");
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmp, finalDir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

export interface KbSkillChange {
  /** 目标工具展示名。 */
  tool: string;
  /** skill 目录绝对路径。 */
  dir: string;
  /** foreign = 同名目录不是 knowbase 建的，未覆盖；failed = 写入出错。 */
  action: "created" | "updated" | "unchanged" | "foreign" | "failed";
  reason?: string;
}

export interface SyncKbSkillOptions {
  hermesHome?: string;
  /** 本机配置了飞书写入应用：写入流程引导 agent 用应用身份。 */
  larkWriteApp?: boolean;
}

/**
 * 把内置 skill 写到所有生效的 skill 目标（与团队 skills 相同的 skillTargets）。
 * 内容与标记一致、且本机副本未被手改时不落盘。单个目标失败不影响其他目标。
 */
export function syncKbSkill(
  dir: string,
  home: string = os.homedir(),
  opts: SyncKbSkillOptions = {}
): KbSkillChange[] {
  const files = buildKbSkillFiles(dir, opts.larkWriteApp);
  const hash = hashFiles(files);
  const out: KbSkillChange[] = [];
  for (const t of skillTargets(home, opts.hermesHome)) {
    const target = path.join(t.dir, KB_SKILL_NAME);
    try {
      const exists = fs.existsSync(target);
      const marker = exists ? readMarker(target) : null;
      if (exists && !marker) {
        out.push({ tool: t.name, dir: target, action: "foreign", reason: "同名目录不是 knowbase 托管的，未覆盖" });
        continue;
      }
      if (marker && marker.hash === hash && marker.copyHash === copyHash(target)) {
        out.push({ tool: t.name, dir: target, action: "unchanged" });
        continue;
      }
      fs.mkdirSync(t.dir, { recursive: true });
      install(t.dir, files, hash);
      out.push({ tool: t.name, dir: target, action: marker ? "updated" : "created" });
    } catch (e) {
      out.push({ tool: t.name, dir: target, action: "failed", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export interface KbSkillRemoval {
  tool: string;
  dir: string;
  /** false = 删除失败，副本还在（与 SkillRemoval 同语义）。 */
  removed: boolean;
  error?: string;
}

/** uninstall 时调用：移除所有目标里带内置标记的 skill；同名的用户目录不碰。 */
export function uninstallKbSkill(home: string = os.homedir(), hermesHome?: string): KbSkillRemoval[] {
  const dirs = new Map(skillTargets(home, hermesHome).map((t) => [t.dir, t.name]));
  for (const t of additionalAgentHomes(home, true, hermesHome)) dirs.set(path.join(t.dir, "skills"), t.name);
  const out: KbSkillRemoval[] = [];
  for (const [skillsHome, tool] of dirs) {
    const target = path.join(skillsHome, KB_SKILL_NAME);
    if (!readMarker(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      out.push({ tool, dir: target, removed: true });
    } catch (e) {
      out.push({ tool, dir: target, removed: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** status 用：各目标里内置 skill 的安装情况。 */
export function kbSkillStatus(home: string = os.homedir(), hermesHome?: string): Array<{ tool: string; dir: string; installed: boolean; foreign: boolean }> {
  return skillTargets(home, hermesHome).map((t) => {
    const target = path.join(t.dir, KB_SKILL_NAME);
    const marker = readMarker(target);
    return { tool: t.name, dir: target, installed: marker !== null, foreign: marker === null && fs.existsSync(target) };
  });
}
