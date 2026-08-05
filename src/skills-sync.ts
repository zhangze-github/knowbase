import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pidAlive } from "./config.js";

/**
 * 把知识库 skills/ 下的 Claude Code skill 单向分发到本机 ~/.claude/skills/。
 *
 * 单向：托管副本是只读分发产物，在 ~/.claude/skills/ 里手改不回写知识库，
 * 下个周期被静默覆盖。贡献路径只有一条——编辑知识库 skills/ 目录。
 *
 * 只对 Claude Code 生效：Codex 没有 skills 目录机制，因此这里不做
 * agent-config.ts 那种多目标抽象。
 */

/** 知识库中存放 skill 的子目录。 */
export const SKILLS_SUBDIR = "skills";

/**
 * 托管副本的目录名前缀。
 * 两个作用：skill 列表里一眼看出哪些是团队的；从机制上消除与成员个人 skill
 * 同名的可能——统一加前缀比「同名时跳过」更好，后者会让该成员静默拿不到团队版。
 */
export const ORG_PREFIX = "org-";

/** 托管标记文件名，兼作所有权证明与变更检测。 */
export const MARKER_NAME = ".knowbase.json";

/** 临时目录后缀，实际目录名还会拼上 pid。 */
export const TMP_SUFFIX = ".knowbase-tmp-";

/**
 * 合法目录名。这是**安全要求**，不是洁癖：源目录名来自共享仓库（任何有写权限的
 * 成员都能改），且会直接拼进 ~/.claude/skills/ 的路径。不校验则 `../../` 这类
 * 名字能让写入落到 home 目录任意位置。
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 源目录名 → 托管副本目录名。名字不合法返回 null。 */
export function prefixedName(name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  // NAME_RE 允许点号，含 TMP_SUFFIX 的名字（如 "a.knowbase-tmp-9"）在语法上合法，
  // 但落到 ~/.claude/skills 后会被 readExistingTargets 永久当成临时目录忽略、
  // 又被 cleanTmpDirs 每周期当垂死临时目录删掉——变成每 60 秒全量重拷一次、
  // 副本周期性消失的病态状态。挡在这一步比事后排查更便宜。
  if (name.includes(TMP_SUFFIX)) return null;
  return name.startsWith(ORG_PREFIX) ? name : ORG_PREFIX + name;
}

/**
 * 改写 SKILL.md frontmatter 中的 name 字段，使其与托管目录名一致。
 * 无 frontmatter / 未闭合 / 无 name 字段返回 null——那不是一个合法 skill。
 *
 * 必须改写而不是只改目录名：本机现有样本中目录名与 name 字段全部一致，
 * 无法判定 Claude Code 按哪个识别 skill。既然是拷贝分发，改写副本可以彻底
 * 消掉这个不确定性——两种识别规则下都正确。
 */
export function rewriteSkillName(md: string, newName: string): string | null {
  const lines = md.split("\n");
  // trimEnd 兼容 CRLF 检出（Windows 上 git 可能把 \n 转成 \r\n）
  if (lines[0]?.trimEnd() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  for (let i = 1; i < end; i++) {
    if (!/^name:\s*/.test(lines[i])) continue;
    // 保留该行原有的 \r，避免把 CRLF 文件改成混合行尾
    const cr = lines[i].endsWith("\r") ? "\r" : "";
    lines[i] = `name: ${newName}${cr}`;
    return lines.join("\n");
  }
  return null;
}

export interface SkillFiles {
  /** 排序后的相对路径，统一用 / 分隔。 */
  files: string[];
  /** 被跳过的软链相对路径，供调用方记日志。 */
  symlinks: string[];
}

/**
 * 列出 skill 目录下所有普通文件。
 *
 * 哈希与拷贝**必须**共用这个函数：两者看到的文件集合一旦不一致，就会出现
 * 「哈希说没变、副本其实缺文件」这种无法自愈的状态。
 *
 * 软链跳过：git 会存软链，而一条指向作者机器路径的软链拷到别人机器上必然
 * 悬空——静默留一条坏链比缺一个文件更难查。
 *
 * skip：只在顶层生效的相对名黑名单。目前唯一用途是给托管副本算「副本自身
 * 哈希」时排除 MARKER_NAME——标记文件里的 syncedAt 每次落盘都变，若把它也
 * 算进哈希，副本哈希永远等于「刚写完那一刻」，跟自己比较毫无意义。源目录
 * 调用方不传这个参数，行为与改动前完全一致。
 */
export function listSkillFiles(dir: string, skip: readonly string[] = []): SkillFiles {
  const skipTop = new Set(skip);
  const files: string[] = [];
  const symlinks: string[] = [];
  const walk = (cur: string, prefix: string): void => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      // 防御性：正常的 org-kb 里 skill 目录下不会有嵌套仓库
      if (e.name === ".git") continue;
      if (prefix === "" && skipTop.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        symlinks.push(rel);
        continue;
      }
      if (e.isDirectory()) walk(path.join(cur, e.name), rel);
      else if (e.isFile()) files.push(rel);
    }
  };
  walk(dir, "");
  return { files: files.sort(), symlinks: symlinks.sort() };
}

/**
 * 源目录内容哈希：相对路径 + 可执行位 + 文件字节，按路径字典序喂进同一个 sha256。
 *
 * - 含路径：否则源里增删文件（内容集合不变时）检测不到。
 * - 排序：否则结果依赖目录遍历顺序，跨平台不稳定。
 * - 含可执行位：skill 可能带脚本，chmod +x 而内容不变时也必须重新分发。
 *
 * skip 原样透传给 listSkillFiles，见其注释。
 */
export function hashSkillDir(dir: string, skip: readonly string[] = []): string {
  const h = crypto.createHash("sha256");
  for (const rel of listSkillFiles(dir, skip).files) {
    const full = path.join(dir, rel);
    const st = fs.statSync(full);
    h.update(rel, "utf8");
    h.update("\0");
    h.update((st.mode & 0o111) !== 0 ? "1" : "0");
    h.update("\0");
    h.update(fs.readFileSync(full));
    h.update("\0");
  }
  return h.digest("hex");
}

export interface SkillSource {
  /** 知识库里的原目录名。 */
  name: string;
  /** 源目录绝对路径。 */
  dir: string;
  /** 托管副本目录名（org- 前缀后）。 */
  target: string;
  /** 源目录内容哈希。 */
  hash: string;
}

/**
 * created/updated/unchanged/foreign/removed 是 planSkills 的决策；
 * invalid 来自源侧校验；failed 是落盘阶段的失败结果。
 */
export type SkillAction =
  | "created"
  | "updated"
  | "unchanged"
  | "foreign"
  | "removed"
  | "invalid"
  | "failed";

export interface SkillChange {
  /** 源名。invalid 时是被跳过的目录名。 */
  name: string;
  /** 托管副本目录名。invalid 时为空串。 */
  target: string;
  action: SkillAction;
  /** invalid / foreign / failed 的原因，用于日志与 status。 */
  reason?: string;
}

/**
 * 仅大小写不同的目标名去重：取排序第一个，其余作为 dropped 返回。
 *
 * 抽成接受数组的纯函数，理由与 agent-config.ts 的 pickIndexName 相同：
 * 「仅大小写不同的两个目录并存」在大小写不敏感的文件系统（macOS 默认 APFS）
 * 上无法落盘构造，只能这样测。
 *
 * 取值必须定死：macOS 不敏感、Linux 敏感，不定死会产生「同一知识库在不同
 * 成员机器上行为不同」的极难排查问题。内部自己排序，不依赖调用方是否排过序。
 */
export function dedupeByTargetCase(sources: SkillSource[]): {
  kept: SkillSource[];
  dropped: Array<{ name: string; winner: string }>;
} {
  const sorted = [...sources].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Map<string, string>();
  const kept: SkillSource[] = [];
  const dropped: Array<{ name: string; winner: string }> = [];
  for (const s of sorted) {
    const key = s.target.toLowerCase();
    const winner = seen.get(key);
    if (winner === undefined) {
      seen.set(key, s.name);
      kept.push(s);
      continue;
    }
    dropped.push({ name: s.name, winner });
  }
  return { kept, dropped };
}

/**
 * 目标名撞车时给用户看的原因。两种碰撞必须分开说：
 *
 * - **仅大小写不同**（`afoo` 与 `Afoo`）：目标名只差大小写。
 * - **加前缀后完全同名**（`deploy` 与 `org-deploy`）：`prefixedName` 对已带前缀的
 *   名字不重复加前缀，两者的 target 都是 `org-deploy`，这不是大小写问题。
 *   这个场景很现实：成员在 skill 列表里看到 `org-deploy`，把
 *   `~/.claude/skills/org-deploy` 整个拷回知识库想「贡献修改」，结果排序上
 *   `deploy` < `org-deploy`，他新加的那份被静默丢掉——此时告诉他「仅大小写
 *   不同」他只会更困惑，得直接告诉他去改哪个目录。
 *
 * 抽成纯函数的理由与 `dedupeByTargetCase` 相同：「仅大小写不同的两个源目录并存」
 * 在大小写不敏感的文件系统（macOS 默认 APFS）上无法落盘构造，只能这样测。
 */
export function collisionReason(name: string, winner: string): string {
  if (name.toLowerCase() === winner.toLowerCase()) {
    return `与 ${winner} 仅大小写不同，已跳过`;
  }
  return (
    `加上 ${ORG_PREFIX} 前缀后与 ${winner} 同名，已跳过` +
    `（改团队版请直接编辑 ${SKILLS_SUBDIR}/${winner}）`
  );
}

/**
 * 取 frontmatter 里某个顶层字段的原始值；无 frontmatter / 无该字段返回 null。
 *
 * 只做「有没有这一行」这种最粗的判断，不解析 YAML：knowbase 的职责是分发，
 * 不是 lint。`description: >` 这种折叠写法在这里会被视为「有值」，正确——
 * 真正的值在下面几行缩进里，不是我们该管的事。
 */
function frontmatterField(md: string, key: string): string | null {
  const lines = md.split("\n");
  if (lines[0]?.trimEnd() !== "---") return null;
  const re = new RegExp(`^${key}:\\s*(.*)$`);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line === "---") return null; // frontmatter 结束，正文里的同名行不算
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * 扫描 <kbDir>/skills 下的一级子目录，校验并计算哈希。
 * skills/ 不存在时返回空结果、绝不抛错——大多数团队 day one 还没有这个目录。
 *
 * protectedTargets：invalid 条目中「目录名合法、算得出托管副本名」的那批 target。
 * 交给 planSkills 在反向扫描时跳过，语义是**「保留上一份好副本」严格优于「删掉」**：
 * 一个成员把 skills/deploy/SKILL.md 的 frontmatter 弄坏（本仓库对 *.md 开了
 * merge=union，并发编辑同一个 skill 产出重复行 frontmatter 是可预期的），
 * deploy 会落进 invalid、从 sources 里消失，若不保护，反向扫描会把全团队机器上
 * 已经装好的 org-deploy 判成孤儿删掉——一个格式错误让所有人丢掉一个能用的 skill。
 * 保护之后副本原样躺着（源不在 sources 里也就不会被更新），源修好后哈希与
 * marker.hash 不同、自然判 updated，自愈。
 * 目录名不合法的算不出 target，也就不可能有对应副本，无需保护。
 */
export function readSkillSources(kbDir: string): {
  sources: SkillSource[];
  invalid: SkillChange[];
  protectedTargets: string[];
} {
  const root = path.join(kbDir, SKILLS_SUBDIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { sources: [], invalid: [], protectedTargets: [] };
  }

  const sources: SkillSource[] = [];
  const invalid: SkillChange[] = [];
  const protectedTargets: string[] = [];
  /** target 传 null 表示目录名不合法（不可能有对应副本，不进保护集合）。 */
  const bad = (name: string, reason: string, target: string | null): void => {
    invalid.push({ name, target: "", action: "invalid", reason });
    if (target) protectedTargets.push(target);
  };

  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const target = prefixedName(name);
    if (!target) {
      bad(name, "目录名不合法（只允许 A-Za-z0-9 开头，含 . _ -）", null);
      continue;
    }
    const dir = path.join(root, name);
    const mdPath = path.join(dir, "SKILL.md");
    let md: string;
    try {
      md = fs.readFileSync(mdPath, "utf8");
    } catch {
      bad(name, "缺少 SKILL.md", target);
      continue;
    }
    if (rewriteSkillName(md, target) === null) {
      bad(name, "SKILL.md 缺少 frontmatter 或 name 字段", target);
      continue;
    }
    // description 与 name 一样是硬要求：Claude Code 靠 description 判断何时触发
    // 一个 skill，没有它就永远不会被用上——分发一个装死的 skill 比不分发更糟，
    // 因为团队会以为流程已经生效。挡在源侧比事后排查便宜得多。
    const desc = frontmatterField(md, "description");
    if (desc === null || desc.trim() === "") {
      bad(name, "SKILL.md 的 frontmatter 缺少 description 字段（Claude Code 靠它触发 skill）", target);
      continue;
    }
    let hash: string;
    try {
      hash = hashSkillDir(dir);
    } catch (err) {
      bad(name, `读取失败：${err instanceof Error ? err.message : String(err)}`, target);
      continue;
    }
    sources.push({ name, dir, target, hash });
  }

  const { kept, dropped } = dedupeByTargetCase(sources);
  for (const d of dropped) {
    // dedupeByTargetCase 的输入全部来自上面 prefixedName 非 null 的分支，
    // 这里再算一次必然拿到同一个值（避免为了带出 target 改动它的返回形状）。
    bad(d.name, collisionReason(d.name, d.winner), prefixedName(d.name));
  }
  return { sources: kept, invalid, protectedTargets };
}

export interface SkillMarker {
  /** 源目录名（知识库里的原名）。 */
  source: string;
  /** 落盘时的源内容哈希。 */
  hash: string;
  /**
   * 落盘时副本自身的内容哈希（不含标记文件本身）。用于检测本机手改。
   * 可选：本次改动之前落盘的老标记没有这个字段，读到时视为「对不上」触发一次
   * 自愈重装，而不是因此判定该目录不是 knowbase 托管的——否则升级后所有旧副本
   * 会被误判成 foreign，永远不再更新。
   */
  copyHash?: string;
  syncedAt: string;
}

export interface ExistingTarget {
  /** ~/.claude/skills 下的目录名。 */
  target: string;
  /** 读到的托管标记；不是 knowbase 托管的为 null。 */
  marker: SkillMarker | null;
  /** 目标副本当前实际内容哈希（不含标记文件）；无标记或读取失败为 null。 */
  copyHash: string | null;
}

/**
 * 纯决策：源列表 + 目标现状 → 动作列表。不碰文件系统，便于把六个分支都测到。
 *
 * 无标记的目标一律不碰——包括用户自己恰好叫 org-xxx 的 skill。所有权信息放在
 * 目录内的标记文件而非集中式 state，是为了让孤儿识别自愈：state 文件丢失会让
 * 托管副本永久变成无人认领的垃圾，标记在目录内则永远认得出来。
 */
export function planSkills(
  sources: SkillSource[],
  existing: ExistingTarget[],
  protectedTargets: readonly string[] = []
): SkillChange[] {
  const changes: SkillChange[] = [];
  const byTarget = new Map(existing.map((e) => [e.target, e]));
  const wanted = new Set<string>();
  const kept = new Set(protectedTargets);

  for (const s of sources) {
    wanted.add(s.target);
    const cur = byTarget.get(s.target);
    if (!cur) {
      changes.push({ name: s.name, target: s.target, action: "created" });
      continue;
    }
    if (!cur.marker) {
      changes.push({
        name: s.name,
        target: s.target,
        action: "foreign",
        reason: "同名目录不是 knowbase 托管的，未覆盖",
      });
      continue;
    }
    // 两个哈希都要对上才算 unchanged：hash 管「源变了没」，copyHash 管「本机
    // 有没有手改副本」，二者是互相独立的漂移来源，缺一个都会漏检。
    // marker.copyHash 为 undefined（老标记）时与任何字符串、包括 null 都不
    // 相等，天然落入 updated 分支——这正是「老标记触发一次自愈重装」的实现方式。
    const same = cur.marker.hash === s.hash && cur.marker.copyHash === cur.copyHash;
    changes.push({
      name: s.name,
      target: s.target,
      action: same ? "unchanged" : "updated",
    });
  }

  // 反向扫：托管副本的源已不在列表中 → 孤儿。覆盖「知识库里删了 skill」与
  // 「重命名了 skill」两种情况。
  //
  // protectedTargets 里的不算孤儿：它们的源还在知识库里，只是本轮校验没通过
  // （frontmatter 坏了之类），副本原样留着等源修好，见 readSkillSources 的注释。
  // 「源目录真的被删了」与「源目录还在但内容坏了」必须区分，否则一个格式错误
  // 就会让全团队丢掉一个能用的 skill。
  for (const e of existing) {
    if (!e.marker) continue;
    if (wanted.has(e.target)) continue;
    if (kept.has(e.target)) continue;
    changes.push({ name: e.marker.source, target: e.target, action: "removed" });
  }

  return changes;
}

/** 托管副本落地目录。只有 Claude Code 有这个机制。 */
export function skillsHomeDir(home: string = os.homedir()): string {
  return path.join(home, ".claude", "skills");
}

/**
 * 读取目标目录现状。
 *
 * 只看 org- 前缀的条目：我们的目标名恒以 org- 开头（prefixedName 保证），
 * 因此非 org- 条目既不可能是目标、也不可能是我们的，跳过既安全又省去每周期
 * 对用户全部个人 skill 的无谓探测。
 *
 * 不按类型（目录/软链/普通文件）过滤：org-a 曾经是目录、被用户换成了普通
 * 文件，也要收进来（marker 必然为 null）。这样它会被 planSkills 判成
 * foreign 而不动，不会被 installSkill 里 rmSync(finalDir,{recursive:true})
 * 静默删掉——「无标记一律不碰」这个不变式对文件和目录要一视同仁。
 */
export function readExistingTargets(skillsHome: string): ExistingTarget[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsHome, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ExistingTarget[] = [];
  for (const e of entries) {
    if (!e.name.startsWith(ORG_PREFIX)) continue;
    if (e.name.includes(TMP_SUFFIX)) continue;
    const dir = path.join(skillsHome, e.name);
    const marker = readMarker(dir);
    // 没标记就不是我们托管的，副本哈希无意义，省一次遍历+哈希的开销
    const copyHash = marker ? hashCopySafe(dir) : null;
    out.push({ target: e.name, marker, copyHash });
  }
  return out;
}

function readMarker(dir: string): SkillMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER_NAME), "utf8")) as
      | Partial<SkillMarker>
      | null;
    // 字段校验后才认所有权：一个被截断或被手改坏的标记不该让我们 rm -rf 这个目录。
    // JSON.parse("null") 不抛错、合法返回 null，上面这个 !m 专门挡这种情况。
    if (!m || typeof m.source !== "string" || typeof m.hash !== "string") return null;
    const marker: SkillMarker = {
      source: m.source,
      hash: m.hash,
      syncedAt: String(m.syncedAt ?? ""),
    };
    // copyHash 类型不对（或没有，即老标记）就留空，不当所有权证据的一部分——
    // 所有权只认 source/hash，copyHash 只用于 planSkills 里的「要不要重装」判断。
    if (typeof m.copyHash === "string") marker.copyHash = m.copyHash;
    return marker;
  } catch {
    return null;
  }
}

/** 目标副本自身内容哈希，跳过标记文件。读取失败（权限、并发删除）返回 null。 */
function hashCopySafe(dir: string): string | null {
  try {
    return hashSkillDir(dir, [MARKER_NAME]);
  } catch {
    return null;
  }
}

/**
 * 清掉上次崩溃残留的临时目录。
 *
 * 只清 pid 已不存活的：临时名带 pid 就是为了让守护进程的周期刷新与用户手跑
 * 的 init 能同时安全地写各自的临时目录，如果这里无差别按名字匹配就删，等于
 * 白白抵消了这个设计。典型场景——init 正在拷一个大 skill、刚写完 marker 准备
 * rename 上位，此刻守护进程的 60 秒周期到点：cleanTmpDirs 若把 init 的临时
 * 目录删了，init 接下来 rmSync(finalDir) 会先删掉守护进程刚装好的正常副本，
 * 而 renameSync(tmp, finalDir) 因 tmp 已被删而失败 → 整个 skill 从磁盘消失，
 * 直到下一周期才重建。解析不出 pid 的（名字被截断、手改过）视为死进程一并清。
 */
function cleanTmpDirs(skillsHome: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(skillsHome);
  } catch {
    return;
  }
  for (const n of names) {
    const idx = n.indexOf(TMP_SUFFIX);
    if (idx === -1) continue;
    const pidStr = n.slice(idx + TMP_SUFFIX.length);
    const pid = /^\d+$/.test(pidStr) ? Number(pidStr) : NaN;
    if (!Number.isNaN(pid) && pidAlive(pid)) continue;
    try {
      fs.rmSync(path.join(skillsHome, n), { recursive: true, force: true });
    } catch {
      // 清不掉不影响本次分发
    }
  }
}

/**
 * 整体替换式安装：临时目录 + rename。
 *
 * - 不做增量：源里删了文件，增量拷贝检测不到，副本里会残留幽灵文件。
 * - 临时目录 + rename：避免「删了旧的、拷贝中途崩溃」留下半个 skill 被
 *   Claude Code 加载。rename 始终同目录、同文件系统。
 * - 临时名带 pid：守护进程的周期刷新与用户手跑的 init 会同时写同一目标，
 *   共用固定临时名会让两个进程交错写入同一临时目录。
 */
function installSkill(src: SkillSource, skillsHome: string): void {
  const finalDir = path.join(skillsHome, src.target);
  const tmp = `${finalDir}${TMP_SUFFIX}${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const rel of listSkillFiles(src.dir).files) {
      const from = path.join(src.dir, rel);
      const to = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      // copyFileSync 实际会把源文件的完整 mode 带到副本上（实测源 0600 → 副本
      // 0600），这里再显式补一次 +x 不是为了「只搬可执行位」，而是不依赖各平台
      // copyFile 的 mode 语义：skill 可以带脚本，丢了 +x 脚本就跑不起来，而这种
      // 失败在 agent 侧极难定位。git 只跟踪 x 位（检出即 644/755），所以副本
      // 权限位实际就是这两种，没有更细的保真需求。
      if ((fs.statSync(from).mode & 0o111) !== 0) fs.chmodSync(to, 0o755);
    }

    const mdPath = path.join(tmp, "SKILL.md");
    const rewritten = rewriteSkillName(fs.readFileSync(mdPath, "utf8"), src.target);
    // readSkillSources 已校验过，这里为 null 只可能是源在扫描后被改坏
    if (rewritten === null) throw new Error("SKILL.md 的 name 字段在分发过程中失效");
    fs.writeFileSync(mdPath, rewritten, "utf8");

    // 副本哈希在标记文件写入之前算：这时 tmp 里还没有 MARKER_NAME，传 skip
    // 只是为了跟 planSkills 那边读到的口径（同样跳过标记文件）保持一致。
    const copyHash = hashSkillDir(tmp, [MARKER_NAME]);
    const marker: SkillMarker = {
      source: src.name,
      hash: src.hash,
      copyHash,
      syncedAt: new Date().toISOString(),
    };
    // 最后写：源侧若误提交了同名文件，这一步会把它盖掉
    fs.writeFileSync(
      path.join(tmp, MARKER_NAME),
      JSON.stringify(marker, null, 2) + "\n",
      "utf8"
    );

    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmp, finalDir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/**
 * 把知识库 skills/ 分发到 ~/.claude/skills/。init 与守护进程每周期共用。
 * 单个 skill 失败记为 failed 并继续下一个：一个坏 skill 不该拖垮整批分发。
 */
export function syncSkills(kbDir: string, home: string = os.homedir()): SkillChange[] {
  const skillsHome = skillsHomeDir(home);
  cleanTmpDirs(skillsHome);

  const { sources, invalid, protectedTargets } = readSkillSources(kbDir);
  const existing = readExistingTargets(skillsHome);
  // 这段不改变行为：sources 和 existing 都空时 planSkills 必然返回空数组，
  // 往下走一样得到 invalid 本身。它不是「不凭空创建 ~/.claude/skills」的安全
  // 网——那个由下面 install 分支里单独出现的 mkdirSync 保证，这里只是提前把
  // 意图写明，省得读代码的人得看完整个循环才确认这点。别在别处依赖这行当兜底。
  if (sources.length === 0 && existing.length === 0) return invalid;

  const plan = planSkills(sources, existing, protectedTargets);
  const byTarget = new Map(sources.map((s) => [s.target, s]));
  const out: SkillChange[] = [...invalid];

  // removed 必须先于 created/updated 执行。只改大小写的重命名（skills/foo →
  // skills/Foo）会得到 [created org-Foo, removed org-foo]，而在大小写不敏感的
  // 文件系统（macOS 默认 APFS）上这两个名字是同一个目录：先装后删会把刚装好的
  // 副本删掉，~/.claude/skills 里那个 skill 直接消失，要等下一周期才恢复。
  // 其余场景下两种顺序等价（同一个 target 不会同时出现在两类动作里）。
  const ordered = [
    ...plan.filter((c) => c.action === "removed"),
    ...plan.filter((c) => c.action !== "removed"),
  ];

  for (const c of ordered) {
    if (c.action === "unchanged" || c.action === "foreign") {
      out.push(c);
      continue;
    }
    try {
      if (c.action === "removed") {
        // target 为空串目前走不到这里（invalid 的空 target 是单独收集的，
        // 从不进入 plan），但这是一行带 rm -rf 的代码：path.join(skillsHome, "")
        // 等于 skillsHome 本身，一旦调用顺序被改（例如日后有人把 invalid 也
        // 塞进 plan 里跑一遍），这行就会清空整个 ~/.claude/skills。挡在这里
        // 让这个不变式靠代码保证，不靠「调用者不会传空 target」的默契。
        if (!c.target) throw new Error("removed 动作缺少合法 target，拒绝执行删除");
        fs.rmSync(path.join(skillsHome, c.target), { recursive: true, force: true });
      } else {
        const src = byTarget.get(c.target)!;
        fs.mkdirSync(skillsHome, { recursive: true });
        installSkill(src, skillsHome);
      }
      out.push(c);
    } catch (e) {
      out.push({
        name: c.name,
        target: c.target,
        action: "failed",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

export interface SkillRemoval {
  target: string;
  /**
   * 是否真的删掉了。
   *
   * **注意与 `AgentConfigRemoval.removed` 的语义相反**：那边 `false` 表示
   * 「文件里本来就没有托管区块」——一个无害的 no-op，真正的失败靠抛异常传递；
   * 这里 `false` 表示「rmSync 失败了，副本还在磁盘上」——必须让用户看见，
   * 否则 uninstall 会谎报成功，而配置已删、status 也不再工作，用户再没有
   * 入口能删掉这份仍被 Claude Code 加载的团队 skill。
   * 两个类型形状一样含义相反，照抄对方的打印惯例就会出这个 bug。
   */
  removed: boolean;
  /** removed 为 false 时的失败原因（权限、目录被占用等）。 */
  error?: string;
}

/**
 * uninstall 时调用：移除所有带托管标记的副本。
 * 无标记的目录一律不碰——包括用户自己手写的 org-* skill。
 */
export function uninstallSkills(home: string = os.homedir()): SkillRemoval[] {
  const skillsHome = skillsHomeDir(home);
  cleanTmpDirs(skillsHome);
  const removals: SkillRemoval[] = [];
  for (const e of readExistingTargets(skillsHome)) {
    if (!e.marker) continue;
    try {
      fs.rmSync(path.join(skillsHome, e.target), { recursive: true, force: true });
      removals.push({ target: e.target, removed: true });
    } catch (err) {
      removals.push({
        target: e.target,
        removed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return removals;
}
