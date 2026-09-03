import fs from "node:fs";
import path from "node:path";
import { MIRROR_MANIFEST } from "../mirror.js";

/** 单个 wiki 节点的导出状态（spec §3.3-2）。 */
export interface MirrorNodeState {
  /** 仓库内相对路径。 */
  path: string;
  /** 上次导出时该节点的 obj_edit_time（字符串秒级时间戳，来自飞书原样保存）。 */
  obj_edit_time: string;
  /** 导出 md 内容（不含 frontmatter 的 synced_at 行，见 exporter.ts contentHash）的 sha256。 */
  hash: string;
}

/**
 * exporter 侧的完整清单（spec §3.3-8）：与成员侧共用同一个文件——
 * 成员侧只读 version/last_sync_at/last_full_check_at/agent_inbox_url 四个字段，
 * space_id/host/nodes 是 exporter 私有状态，随仓库分发但成员侧不消费。
 */
export interface ExporterManifest {
  version: 1;
  space_id: string;
  /** 租户域名（如 acme.feishu.cn）：node_token 拼 feishu_url 必需（spec §3.5）。 */
  host: string;
  last_sync_at?: string;
  last_full_check_at?: string;
  agent_inbox_url?: string;
  nodes: Record<string, MirrorNodeState>;
}

export function newManifest(spaceId: string, host: string, inboxUrl?: string): ExporterManifest {
  const m: ExporterManifest = { version: 1, space_id: spaceId, host, nodes: {} };
  if (inboxUrl) m.agent_inbox_url = inboxUrl;
  return m;
}

export function readExporterManifest(repoDir: string): ExporterManifest | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(repoDir, MIRROR_MANIFEST), "utf8")
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const m = parsed as ExporterManifest;
    if (!m.nodes) m.nodes = {};
    return m;
  } catch {
    return null;
  }
}

export function writeExporterManifest(repoDir: string, m: ExporterManifest): void {
  fs.writeFileSync(
    path.join(repoDir, MIRROR_MANIFEST),
    JSON.stringify(m, null, 2) + "\n",
    "utf8"
  );
}
