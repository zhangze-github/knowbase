import path from "node:path";
import type { DocxBlock } from "./lark-client.js";

/**
 * 渲染上下文（spec §3.3-3/5/6）。pathForToken/urlForToken/selfPath 用于
 * mention_doc 的库内链接双链改写（spec §3.3-5）。
 */
export interface RenderCtx {
  /** 本文档飞书 URL（降级占位用）。 */
  selfUrl: string;
  /** 本文档在仓库内的相对路径（用于把 pathForToken 命中的目标路径转成相对链接；缺省时直接用目标路径）。 */
  selfPath?: string;
  /** 库内链接改写：token → 仓库相对路径；未命中（返回 undefined）则不做双链改写。 */
  pathForToken?: (token: string) => string | undefined;
  /** token → 飞书原链接（mention_doc 未提供 url 时兜底）。 */
  urlForToken?: (token: string) => string | undefined;
}

/** BlockType 数值 → 名称（来自 feishu-docx 的 BlockType enum；Task 5 补充复杂块与降级涉及的类型）。 */
const enum BlockType {
  Page = 1,
  Text = 2,
  Heading1 = 3,
  Heading9 = 11,
  Bullet = 12,
  Ordered = 13,
  Code = 14,
  Quote = 15,
  TodoList = 17,
  Bitable = 18,
  Callout = 19,
  Divider = 22,
  File = 23,
  Iframe = 26,
  Image = 27,
  Mindnote = 28,
  Sheet = 30,
  Table = 31,
  TableCell = 32,
  Board = 43,
}

/** code.style.language 数值 → 围栏代码块语言标注；查不到给空字符串（无语言标注）。 */
const LANGUAGE_MAP: Record<number, string> = {
  1: "plaintext",
  8: "bash",
  22: "go",
  28: "java",
  30: "javascript",
  49: "python",
  53: "rust",
  63: "typescript",
};

/** 同父连续 Ordered 序列的列表类型（渲染为 `- `/`- [ ]` 而非空行分隔的普通块）。 */
function isListBlockType(t: number): boolean {
  return t === BlockType.Bullet || t === BlockType.Ordered || t === BlockType.TodoList;
}

// ---- 防御性取数工具：飞书响应字段是 unknown，任何形状异常都不应 throw（本任务约束：纯函数、never throw）----
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 取 `block.<key>.elements`，形状不对时返回空数组（未知/缺失字段静默跳过）。 */
function getElements(block: DocxBlock, key: string): unknown[] {
  return asArray(asRecord(block[key]).elements);
}

/**
 * 文本元素通用样式包裹（spec §3.3-3 块取数约定）：可叠加，包裹顺序固定为
 * inline_code 最内 → bold → italic → strikethrough → link 最外；
 * link.url 是飞书侧 encodeURIComponent 过的，渲染前需 decodeURIComponent 还原。
 */
function wrapStyle(content: string, style: Record<string, unknown>): string {
  let s = content;
  if (style.inline_code) s = "`" + s + "`";
  if (style.bold) s = `**${s}**`;
  if (style.italic) s = `*${s}*`;
  if (style.strikethrough) s = `~~${s}~~`;
  const link = asRecord(style.link);
  const url = asString(link.url);
  if (url) {
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      // url 本身不是合法的 percent-encoding：原样使用，不因个别脏数据中断整篇渲染
    }
    s = `[${s}](${decoded})`;
  }
  return s;
}

/**
 * mention_doc（正文里 @另一篇文档）渲染（spec §3.3-5 库内链接改写）：
 * ctx.pathForToken 命中目标仓库路径 → 输出「本地相对路径 + 飞书原链接」双链；
 * 未命中（未配置 pathForToken 或该 token 查不到）→ 退化为单个飞书链接。
 * url 统一取 mention_doc.url ?? urlForToken(token) ?? selfUrl（保证任何情况下都有一个可跳转的链接）。
 */
function renderMentionDoc(doc: Record<string, unknown>, ctx: RenderCtx): string {
  const title = asString(doc.title) || "文档";
  const token = asString(doc.token);
  const url = asString(doc.url) || ctx.urlForToken?.(token) || ctx.selfUrl;
  const targetPath = ctx.pathForToken?.(token);
  if (targetPath) {
    // selfPath 缺省时直接用目标路径（无法计算相对路径，退而求其次给一个仓库内路径）
    const relPath = ctx.selfPath ? path.posix.relative(path.posix.dirname(ctx.selfPath), targetPath) : targetPath;
    return `[${title}](${relPath})（[飞书](${url})）`;
  }
  return `[${title}](${url})`;
}

/**
 * 渲染单个 element：text_run / equation / mention_user / mention_doc；
 * 其余未知 element 类型（画板/附件引用等）静默跳过，不产出任何文本。
 */
function renderElement(el: unknown, ctx: RenderCtx): string {
  const e = asRecord(el);
  if (e.text_run !== undefined) {
    const run = asRecord(e.text_run);
    return wrapStyle(asString(run.content), asRecord(run.text_element_style));
  }
  if (e.equation !== undefined) {
    return `$${asString(asRecord(e.equation).content)}$`;
  }
  if (e.mention_user !== undefined) {
    return `@${asString(asRecord(e.mention_user).user_id)}`;
  }
  if (e.mention_doc !== undefined) {
    return renderMentionDoc(asRecord(e.mention_doc), ctx);
  }
  return "";
}

function renderElements(elements: unknown[], ctx: RenderCtx): string {
  return elements.map((el) => renderElement(el, ctx)).join("");
}

/** Code 块内容按纯文本拼接（不做样式包裹——围栏代码块里不应再嵌 Markdown 语法）。 */
function renderRawText(elements: unknown[]): string {
  return elements.map((el) => asString(asRecord(asRecord(el).text_run).content)).join("");
}

/** 无法转换的复杂块占位（spec §3.3-6）：Bitable/Sheet/Board/Iframe/File/Mindnote 及一切未实现类型统一走此格式。 */
function unsupportedPlaceholder(pad: string, blockType: number, ctx: RenderCtx): string {
  return `${pad}> ⚠ 此处为无法转换的内容（type ${blockType}），请在飞书查看：[原文](${ctx.selfUrl})`;
}

interface Walker {
  map: Map<string, DocxBlock>;
  ctx: RenderCtx;
  /** 已渲染过的 block_id：防御畸形/成环的 children，避免重复渲染甚至递归爆栈。 */
  visited: Set<string>;
}

/**
 * Table=31 渲染为 Markdown 表格（spec §3.3-6）：`table.property.row_size/column_size`
 * 决定行列数，`table.cells` 是 TableCell（block_type=32）的 block_id 数组、行优先排列。
 * 每个 cell 的内容 = 其 children 渲染后压成单行（换行替换为空格、`|` 转义为 `\|`）；
 * 首行作表头，随后插入分隔行。cell 内容通过 renderBlocks 渲染，会把其 children 计入
 * visited，避免与其他路径重复渲染。
 */
function renderTable(block: DocxBlock, pad: string, w: Walker): string {
  const table = asRecord(block.table);
  const property = asRecord(table.property);
  const rowSize = Math.max(0, Math.trunc(Number(property.row_size)) || 0);
  const colSize = Math.max(0, Math.trunc(Number(property.column_size)) || 0);
  if (rowSize === 0 || colSize === 0) return "";
  const cellIds = asArray(table.cells).filter((c): c is string => typeof c === "string");

  const renderCell = (id: string | undefined): string => {
    if (!id || w.visited.has(id)) return "";
    const cell = w.map.get(id);
    if (!cell) return "";
    w.visited.add(id);
    const kids = asArray(cell.children).filter((c): c is string => typeof c === "string");
    const rendered = renderBlocks(kids, 0, w);
    // 换行→空格：连续换行（多个子块间的空行分隔符 `\n\n`）也只压成一个空格，
    // 不用 \s+（会连带吃掉正文里用户本来打的多个空格）
    return rendered.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
  };

  const rows: string[][] = [];
  for (let r = 0; r < rowSize; r++) {
    const row: string[] = [];
    for (let c = 0; c < colSize; c++) row.push(renderCell(cellIds[r * colSize + c]));
    rows.push(row);
  }

  const lines = [
    `${pad}| ${rows[0].join(" | ")} |`,
    `${pad}| ${rows[0].map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((row) => `${pad}| ${row.join(" | ")} |`),
  ];
  return lines.join("\n");
}

/**
 * 渲染一个 block 自身的行内容（不含与兄弟块之间的分隔符，由 renderBlocks 统一处理）。
 * orderedIndex：当前块若是 Ordered，其在本轮连续序列中的序号（由调用方维护并传入）。
 */
function renderBlock(block: DocxBlock, depth: number, orderedIndex: number, w: Walker): string {
  const pad = "  ".repeat(depth);
  const children = asArray(block.children).filter((c): c is string => typeof c === "string");

  switch (block.block_type) {
    case BlockType.Text: {
      const line = pad + renderElements(getElements(block, "text"), w.ctx);
      return appendChildren(line, children, depth, w, false);
    }
    case BlockType.Bullet: {
      const line = pad + "- " + renderElements(getElements(block, "bullet"), w.ctx);
      return appendChildren(line, children, depth, w, true);
    }
    case BlockType.Ordered: {
      const line = pad + `${orderedIndex}. ` + renderElements(getElements(block, "ordered"), w.ctx);
      return appendChildren(line, children, depth, w, true);
    }
    case BlockType.Code: {
      const style = asRecord(asRecord(block.code).style);
      const lang = LANGUAGE_MAP[Number(style.language)] ?? "";
      const content = renderRawText(getElements(block, "code"));
      return `${pad}\`\`\`${lang}\n${content}\n${pad}\`\`\``;
    }
    case BlockType.Quote: {
      const line = pad + "> " + renderElements(getElements(block, "quote"), w.ctx);
      return appendChildren(line, children, depth, w, false);
    }
    case BlockType.TodoList: {
      const done = Boolean(asRecord(asRecord(block.todo).style).done);
      const line = pad + `- [${done ? "x" : " "}] ` + renderElements(getElements(block, "todo"), w.ctx);
      return appendChildren(line, children, depth, w, true);
    }
    case BlockType.Divider:
      return `${pad}---`;
    case BlockType.Table:
      return renderTable(block, pad, w);
    case BlockType.Callout: {
      // Callout 本身无 elements，内容即 children；渲染后逐行加 `> ` 前缀，保底为引用块形式（spec §3.3-6）
      const inner = renderBlocks(children, 0, w);
      if (!inner) return "";
      return inner
        .split("\n")
        .map((line) => `${pad}> ${line}`)
        .join("\n");
    }
    case BlockType.Image:
      // v1 不下载图片——保持仓库纯文本，二进制资产（图片/附件）留待后续版本处理（spec §3.3-6 取舍）
      return `${pad}> 🖼 图片见原文：[${w.ctx.selfUrl}](${w.ctx.selfUrl})`;
    default: {
      // Heading1..Heading9（3..11）：级别 = block_type - 2，封顶 6（spec §3.3-3：飞书支持到 9 级，Markdown 只有 6 级）
      if (block.block_type >= BlockType.Heading1 && block.block_type <= BlockType.Heading9) {
        const n = block.block_type - 2;
        const level = Math.min(n, 6);
        const line = pad + "#".repeat(level) + " " + renderElements(getElements(block, `heading${n}`), w.ctx);
        return appendChildren(line, children, depth, w, false);
      }
      // Bitable/Sheet/Board/Iframe/File/Mindnote 及一切未实现类型：转换器对任何输入 never throw，
      // 统一降级为「无法转换的内容」占位，附飞书原文链接方便用户手动查看（spec §3.3-6）。
      return unsupportedPlaceholder(pad, block.block_type, w.ctx);
    }
  }
}

/**
 * 拼接子块渲染结果：列表项（Bullet/Ordered/TodoList）的子块是嵌套子列表——
 * 缩进 +1 层、与父行单换行相连；其余块（Text/Heading/Quote）的子块是同级延续内容——
 * 深度不变、与父行空行分隔，和普通块间分隔规则一致（spec §3.3-3 行合并规则）。
 */
function appendChildren(line: string, children: string[], depth: number, w: Walker, isListItem: boolean): string {
  if (children.length === 0) return line;
  const childDepth = isListItem ? depth + 1 : depth;
  const rendered = renderBlocks(children, childDepth, w);
  if (!rendered) return line;
  return line + (isListItem ? "\n" : "\n\n") + rendered;
}

/**
 * 渲染一组兄弟块 id（深度优先，flat map 按 children 顺序查）。维护 Ordered 的连续
 * 编号计数器——遇到「真实产出可见内容」的非 Ordered 块才重置，保证「打断后重新从 1
 * 计数」；不可见块（如飞书里两个列表项之间敲的空段落，渲染为空串）既不进输出、也不
 * 影响编号——它对读者不存在，不应被当成「打断」。
 * 相邻两个列表块（Bullet/Ordered/TodoList）之间单换行相连，其余块间空行分隔。
 */
function renderBlocks(ids: string[], depth: number, w: Walker): string {
  const parts: string[] = [];
  let orderedCounter = 0;
  let prevType: number | undefined;

  for (const id of ids) {
    if (w.visited.has(id)) continue; // 防御成环/重复引用
    const block = w.map.get(id);
    if (!block) continue;
    w.visited.add(id);

    const isOrdered = block.block_type === BlockType.Ordered;
    const candidateCounter = isOrdered ? orderedCounter + 1 : orderedCounter;
    const rendered = renderBlock(block, depth, candidateCounter, w);
    // 纯空白（含只有缩进 pad 的嵌套空块）视同不可见：不进输出、不影响编号/间距判定
    if (rendered.trim() === "") continue;

    orderedCounter = isOrdered ? candidateCounter : 0;

    if (parts.length === 0) {
      parts.push(rendered);
    } else {
      const bothList = isListBlockType(block.block_type) && prevType !== undefined && isListBlockType(prevType);
      parts.push((bothList ? "\n" : "\n\n") + rendered);
    }
    prevType = block.block_type;
  }
  return parts.join("");
}

/**
 * docx block 树 → Markdown 正文（spec §3.3-3）。纯函数、无 IO，对任何输入 never throw——
 * 输入形状异常时尽力渲染，取不到的字段静默降级为空，交由上层 diff/写文件流程继续跑。
 */
export function renderDocxToMarkdown(blocks: DocxBlock[], ctx: RenderCtx): string {
  try {
    const map = new Map<string, DocxBlock>();
    for (const b of blocks) {
      if (b && typeof b.block_id === "string") map.set(b.block_id, b);
    }
    const root = blocks.find((b) => b && b.block_type === BlockType.Page);
    if (!root) return "";
    const rootChildren = asArray(root.children).filter((c): c is string => typeof c === "string");
    const w: Walker = { map, ctx, visited: new Set() };
    return renderBlocks(rootChildren, 0, w);
  } catch {
    // 转换器契约是 never throw；任何未预料的形状问题都不应打断整个导出循环（spec §3.6 错误哲学同一精神）
    return "";
  }
}
