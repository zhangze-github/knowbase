import type { DocxBlock } from "./lark-client.js";

/**
 * 渲染上下文（spec §3.3-3/5）。pathForToken/urlForToken 供 Task 5 的库内链接
 * 双链改写使用；本任务（基础块）不消费，仅先落好接口形状。
 */
export interface RenderCtx {
  /** 本文档飞书 URL（降级占位用）。 */
  selfUrl: string;
  /** 库内链接改写（Task 5 用）：token → 仓库相对路径。 */
  pathForToken?: (token: string) => string | undefined;
  /** token → 飞书原链接（mention_doc 未提供 url 时兜底，Task 5 用）。 */
  urlForToken?: (token: string) => string | undefined;
}

/** BlockType 数值 → 名称（仅本任务覆盖的基础块，来自 feishu-docx 的 BlockType enum）。 */
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
  Divider = 22,
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
 * 渲染单个 element：text_run / equation / mention_user 是本任务范围；
 * mention_doc 先按 brief 降级为 `[标题](原url)`，Task 5 用 ctx.pathForToken 接管双链改写；
 * 其余未知 element 类型（画板/附件引用等）静默跳过，不产出任何文本。
 */
function renderElement(el: unknown, _ctx: RenderCtx): string {
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
    const doc = asRecord(e.mention_doc);
    return `[${asString(doc.title)}](${asString(doc.url)})`;
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

interface Walker {
  map: Map<string, DocxBlock>;
  ctx: RenderCtx;
  /** 已渲染过的 block_id：防御畸形/成环的 children，避免重复渲染甚至递归爆栈。 */
  visited: Set<string>;
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
    default: {
      // Heading1..Heading9（3..11）：级别 = block_type - 2，封顶 6（spec §3.3-3：飞书支持到 9 级，Markdown 只有 6 级）
      if (block.block_type >= BlockType.Heading1 && block.block_type <= BlockType.Heading9) {
        const n = block.block_type - 2;
        const level = Math.min(n, 6);
        const line = pad + "#".repeat(level) + " " + renderElements(getElements(block, `heading${n}`), w.ctx);
        return appendChildren(line, children, depth, w, false);
      }
      // 本任务未覆盖的块类型（表格/画板/多维表格等）留给 Task 5 的降级占位处理；
      // 这里只保证 never throw——渲染为空，不吞掉兄弟块的分隔逻辑。
      return "";
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
