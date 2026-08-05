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
