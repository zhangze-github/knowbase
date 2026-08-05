import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

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
 */
export function listSkillFiles(dir: string): SkillFiles {
  const files: string[] = [];
  const symlinks: string[] = [];
  const walk = (cur: string, prefix: string): void => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      // 防御性：正常的 org-kb 里 skill 目录下不会有嵌套仓库
      if (e.name === ".git") continue;
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
 */
export function hashSkillDir(dir: string): string {
  const h = crypto.createHash("sha256");
  for (const rel of listSkillFiles(dir).files) {
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
 * 扫描 <kbDir>/skills 下的一级子目录，校验并计算哈希。
 * skills/ 不存在时返回空结果、绝不抛错——大多数团队 day one 还没有这个目录。
 */
export function readSkillSources(kbDir: string): {
  sources: SkillSource[];
  invalid: SkillChange[];
} {
  const root = path.join(kbDir, SKILLS_SUBDIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { sources: [], invalid: [] };
  }

  const sources: SkillSource[] = [];
  const invalid: SkillChange[] = [];
  const bad = (name: string, reason: string): void => {
    invalid.push({ name, target: "", action: "invalid", reason });
  };

  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const target = prefixedName(name);
    if (!target) {
      bad(name, "目录名不合法（只允许 A-Za-z0-9 开头，含 . _ -）");
      continue;
    }
    const dir = path.join(root, name);
    const mdPath = path.join(dir, "SKILL.md");
    let md: string;
    try {
      md = fs.readFileSync(mdPath, "utf8");
    } catch {
      bad(name, "缺少 SKILL.md");
      continue;
    }
    if (rewriteSkillName(md, target) === null) {
      bad(name, "SKILL.md 缺少 frontmatter 或 name 字段");
      continue;
    }
    let hash: string;
    try {
      hash = hashSkillDir(dir);
    } catch (err) {
      bad(name, `读取失败：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    sources.push({ name, dir, target, hash });
  }

  const { kept, dropped } = dedupeByTargetCase(sources);
  for (const d of dropped) bad(d.name, `与 ${d.winner} 仅大小写不同，已跳过`);
  return { sources: kept, invalid };
}

export interface SkillMarker {
  /** 源目录名（知识库里的原名）。 */
  source: string;
  /** 落盘时的源内容哈希。 */
  hash: string;
  syncedAt: string;
}

export interface ExistingTarget {
  /** ~/.claude/skills 下的目录名。 */
  target: string;
  /** 读到的托管标记；不是 knowbase 托管的为 null。 */
  marker: SkillMarker | null;
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
  existing: ExistingTarget[]
): SkillChange[] {
  const changes: SkillChange[] = [];
  const byTarget = new Map(existing.map((e) => [e.target, e]));
  const wanted = new Set<string>();

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
    changes.push({
      name: s.name,
      target: s.target,
      action: cur.marker.hash === s.hash ? "unchanged" : "updated",
    });
  }

  // 反向扫：托管副本的源已不在列表中 → 孤儿。覆盖「知识库里删了 skill」与
  // 「重命名了 skill」两种情况。
  for (const e of existing) {
    if (!e.marker) continue;
    if (wanted.has(e.target)) continue;
    changes.push({ name: e.marker.source, target: e.target, action: "removed" });
  }

  return changes;
}
