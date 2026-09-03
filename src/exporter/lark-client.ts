import type { WikiNode } from "./tree-diff.js";

export interface DocxBlock {
  block_id: string;
  block_type: number;
  parent_id?: string;
  children?: string[];
  [k: string]: unknown;
}

export interface LarkClientOpts {
  appId: string;
  appSecret: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ENDPOINT = "https://open.feishu.cn";
const MAX_RETRIES = 5;
/** token 提前刷新窗口：飞书 expire 通常 7200s，提前 5 分钟避免边界失效。 */
const TOKEN_SLACK_MS = 300 * 1000;

export class LarkClient {
  private opts: LarkClientOpts & { endpoint: string };
  private token: string | null = null;
  private tokenExpireAt = 0;

  constructor(opts: LarkClientOpts) {
    this.opts = { endpoint: DEFAULT_ENDPOINT, ...opts };
  }

  private fetchFn(): typeof fetch {
    return this.opts.fetchFn ?? fetch;
  }
  private sleep(ms: number): Promise<void> {
    return (this.opts.sleep ?? ((m) => new Promise((r) => setTimeout(r, m))))(ms);
  }

  async tenantToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpireAt) return this.token;
    const res = await this.fetchFn()(
      `${this.opts.endpoint}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }),
      }
    );
    const body = (await res.json()) as { code: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`获取 tenant token 失败：code=${body.code} ${body.msg ?? ""}`);
    }
    this.token = body.tenant_access_token;
    this.tokenExpireAt = Date.now() + (body.expire ?? 7200) * 1000 - TOKEN_SLACK_MS;
    return this.token;
  }

  /**
   * 统一请求：鉴权 + 限流退避（HTTP 429 / code 99991400，读 x-ogw-ratelimit-reset 秒，
   * 缺省 5s，最多 5 次）+ code!==0 抛错。spec §3.6：抛错由 exporter 循环捕获记日志。
   */
  async request<T>(
    method: "GET" | "POST",
    apiPath: string,
    query?: Record<string, string>,
    reqBody?: unknown
  ): Promise<T> {
    const qs = query ? `?${new URLSearchParams(query)}` : "";
    for (let attempt = 0; ; attempt++) {
      const token = await this.tenantToken();
      const res = await this.fetchFn()(`${this.opts.endpoint}${apiPath}${qs}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: reqBody === undefined ? undefined : JSON.stringify(reqBody),
      });
      const body = (await res.json()) as { code: number; msg?: string; data?: unknown };
      if (res.status === 429 || body.code === 99991400) {
        if (attempt >= MAX_RETRIES) throw new Error(`飞书限流重试 ${MAX_RETRIES} 次仍失败：${apiPath}`);
        const reset = parseInt(res.headers.get("x-ogw-ratelimit-reset") ?? "", 10);
        await this.sleep((Number.isFinite(reset) && reset > 0 ? reset : 5) * 1000);
        continue;
      }
      if (body.code !== 0) throw new Error(`飞书 API 失败 code=${body.code} msg=${body.msg ?? ""}（${apiPath}）`);
      return body.data as T;
    }
  }

  /** 分页迭代直到 has_more=false，聚合 items。 */
  private async listAll<T>(apiPath: string, query: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const q = { ...query, ...(pageToken ? { page_token: pageToken } : {}) };
      const data = await this.request<{ items?: T[]; has_more?: boolean; page_token?: string }>("GET", apiPath, q);
      out.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return out;
  }

  /** BFS 拉全树（spec §3.3-1）：顶层 → 逐个 has_child 展开，保证输出 BFS 序。 */
  async listAllSpaceNodes(spaceId: string, rootNodeToken?: string): Promise<WikiNode[]> {
    const result: WikiNode[] = [];
    const queue: (string | undefined)[] = [rootNodeToken];
    while (queue.length > 0) {
      const parent = queue.shift();
      const q: Record<string, string> = { page_size: "50" };
      if (parent) q.parent_node_token = parent;
      const nodes = await this.listAll<WikiNode>(`/open-apis/wiki/v2/spaces/${spaceId}/nodes`, q);
      for (const node of nodes) {
        result.push(node);
        if (node.has_child) queue.push(node.node_token);
      }
    }
    return result;
  }

  async getNode(token: string): Promise<{ space_id: string; node: WikiNode }> {
    // 飞书 wiki-v2 get_node 官方响应中 space_id 位于 data.node 内部（非 data 顶层同级字段）；spec §3.2。
    const data = await this.request<{ node: WikiNode & { space_id?: string } }>(
      "GET", "/open-apis/wiki/v2/spaces/get_node", { token }
    );
    return { space_id: data.node.space_id ?? "", node: data.node };
  }

  async listDocBlocks(documentId: string): Promise<DocxBlock[]> {
    return this.listAll<DocxBlock>(`/open-apis/docx/v1/documents/${documentId}/blocks`, {
      page_size: "500",
      document_revision_id: "-1",
    });
  }
}
