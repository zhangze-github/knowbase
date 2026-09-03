import type { MirrorNodeState } from "./manifest.js";

/** wiki 节点（字段名与飞书 API 原样对齐，来源见计划 Global Constraints）。 */
export interface WikiNode {
  node_token: string;
  obj_token: string;
  obj_type: string;
  parent_node_token: string;
  title: string;
  obj_edit_time: string;
  has_child: boolean;
}

export interface PlannedNode { node: WikiNode; path: string }

/**
 * 标题 → 合法文件名（spec §3.3-4）。跨平台最严格集（Windows）为准：
 * 非法字符替换为 -、折叠连续 -、去首尾空白与点；清洗成空时用 token 兜底
 * 的逻辑在 planPaths（这里拿不到 token）。
 */
export function sanitizeTitle(title: string): string {
  return title
    .trim() // 先去首尾空白再替换：否则空白变成的 - 会残留在首尾
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^\.+|[\s.]+$/g, "");
}

/**
 * 节点树 → 仓库相对路径（spec §3.3-4）。
 * 有子节点的节点既是目录又有正文：目录 <title>/ + 正文 <title>/<title>.md，
 * agent 看树即懂；node_token 是稳定身份，标题变化产生 move 而非删建。
 */
export function planPaths(nodes: WikiNode[], rootToken?: string): Map<string, PlannedNode> {
  const byParent = new Map<string, WikiNode[]>();
  for (const node of nodes) {
    const arr = byParent.get(node.parent_node_token) ?? [];
    arr.push(node);
    byParent.set(node.parent_node_token, arr);
  }
  const out = new Map<string, PlannedNode>();

  const walk = (parentToken: string, parentDir: string): void => {
    const children = byParent.get(parentToken) ?? [];
    const used = new Set<string>(); // 本层已占用的「基名」（目录与文件分别带后缀区分）
    for (const node of children) {
      let base = sanitizeTitle(node.title);
      if (base === "") base = node.node_token.slice(0, 8);
      // 同父重名：目录看 base+"/"，文件看 base+".md"
      const key = node.has_child ? base + "/" : base + ".md";
      let finalBase = base;
      if (used.has(key)) {
        finalBase = `${base}-${node.node_token.slice(0, 6)}`;
      }
      used.add(node.has_child ? finalBase + "/" : finalBase + ".md");
      const prefix = parentDir === "" ? "" : parentDir + "/";
      if (node.has_child) {
        const dir = prefix + finalBase;
        out.set(node.node_token, { node, path: `${dir}/${finalBase}.md` });
        walk(node.node_token, dir);
      } else {
        out.set(node.node_token, { node, path: `${prefix}${finalBase}.md` });
      }
    }
  };

  walk(rootToken ?? "", "");
  return out;
}

export interface TreeDiff {
  /** 需要（重新）导出内容：新增，或 obj_edit_time 变化（含移动且变化者）。 */
  toExport: PlannedNode[];
  /** 路径变化 → git mv；与 toExport 可交叠（先 mv 再重写）。 */
  toMove: { from: string; to: PlannedNode }[];
  /** 清单里有、树上已消失 → 删除文件。 */
  toRemove: { node_token: string; path: string }[];
}

export function diffTree(
  planned: Map<string, PlannedNode>,
  prev: Record<string, MirrorNodeState>
): TreeDiff {
  const toExport: PlannedNode[] = [];
  const toMove: TreeDiff["toMove"] = [];
  const toRemove: TreeDiff["toRemove"] = [];

  for (const [token, p] of planned) {
    const old = prev[token];
    if (!old) {
      toExport.push(p);
      continue;
    }
    if (old.path !== p.path) toMove.push({ from: old.path, to: p });
    if (old.obj_edit_time !== p.node.obj_edit_time) toExport.push(p);
  }
  for (const [token, old] of Object.entries(prev)) {
    if (!planned.has(token)) toRemove.push({ node_token: token, path: old.path });
  }
  return { toExport, toMove, toRemove };
}
