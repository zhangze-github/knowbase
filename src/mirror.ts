import fs from "node:fs";
import path from "node:path";

/**
 * 飞书镜像模式（spec §4）：仓库根存在本清单文件即为镜像仓库。
 * 清单由 exporter 写入并随仓库分发，成员侧只读消费。
 */
export const MIRROR_MANIFEST = ".knowbase-mirror.json";

/** 成员侧消费的清单字段（spec §3.4/§5）；exporter 的其余字段原样保留不管。 */
export interface MirrorManifest {
  version: number;
  /** 最近一次 exporter 成功导出时刻（ISO8601）。 */
  last_sync_at?: string;
  /** 最近一次全量对账时刻（ISO8601）。 */
  last_full_check_at?: string;
  /** 「Agent 沉淀」目录的飞书 wiki URL，注入 agent 提示词（spec §5）。 */
  agent_inbox_url?: string;
}

export function mirrorManifestPath(dir: string): string {
  return path.join(dir, MIRROR_MANIFEST);
}

/**
 * 模式识别只看文件存在与否、刻意不解析内容：清单损坏时若退回经典模式，
 * daemon 会开始把成员的本地改动 commit/push 进镜像仓库——比「暂时读不到
 * 新鲜度」严重得多。损坏只影响 status 的新鲜度展示（spec §4.1）。
 */
export function isMirrorMode(dir: string): boolean {
  return fs.existsSync(mirrorManifestPath(dir));
}

export function readMirrorManifest(dir: string): MirrorManifest | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(mirrorManifestPath(dir), "utf8")
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as MirrorManifest;
  } catch {
    return null;
  }
}
