import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { LarkClient } from "../src/exporter/lark-client.js";

type Route = (url: string, init?: RequestInit) => { status?: number; headers?: Record<string, string>; body: unknown };

function fakeFetch(route: Route): typeof fetch {
  return (async (url: any, init?: any) => {
    const r = route(String(url), init);
    return {
      status: r.status ?? 200,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body,
    } as unknown as Response;
  }) as typeof fetch;
}

function client(route: Route) {
  const calls: string[] = [];
  const c = new LarkClient({
    appId: "id", appSecret: "sec",
    fetchFn: fakeFetch((u, i) => { calls.push(u); return route(u, i); }),
    sleep: async () => {},
  });
  return { c, calls };
}

const TOKEN_BODY = { code: 0, tenant_access_token: "tok1", expire: 7200 };

describe("LarkClient", () => {
  it.each([
    ["token", "headers"],
    ["token", "body"],
    ["API", "headers"],
    ["API", "body"],
  ] as const)("bounds stalled %s %s and closes the HTTP connection", async (stage, stall) => {
    let markClosed!: (closedBeforeResponseEnded: boolean) => void;
    const connectionClosed = new Promise<boolean>((resolve) => { markClosed = resolve; });
    const server = createServer((req, res) => {
      const isToken = req.url?.includes("tenant_access_token");
      if ((stage === "token") === isToken) {
        res.on("close", () => { markClosed(!res.writableEnded); });
        if (stall === "body") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.write('{"code":0,');
        }
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(TOKEN_BODY));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const c = new LarkClient({
        appId: "private-app-id", appSecret: "private-app-secret",
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requestTimeoutMs: 100,
      });
      const operation = stage === "token" ? c.tenantToken() : c.request("GET", "/stalled");
      const bounded = Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          guard = setTimeout(() => reject(new Error("request did not stop within 1s")), 1000);
        }),
      ]);
      const error = await bounded.catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/飞书请求超时.*100ms/);
      expect((error as Error).message).not.toMatch(/private-app-id|private-app-secret/);
      await expect(Promise.race([
        connectionClosed,
        new Promise<never>((_, reject) => {
          clearTimeout(guard);
          guard = setTimeout(() => reject(new Error("HTTP connection was not aborted")), 1000);
        }),
      ])).resolves.toBe(true);
    } finally {
      clearTimeout(guard);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("stops retrying after five rate-limit retries", async () => {
    let hits = 0;
    const { c } = client((u) => {
      if (u.includes("tenant_access_token")) return { body: TOKEN_BODY };
      hits++;
      return { status: 429, body: { code: 99991400 } };
    });
    await expect(c.request("GET", "/limited")).rejects.toThrow(/限流重试 5 次仍失败/);
    expect(hits).toBe(6);
  });

  it("token 缓存：两次请求只取一次 token", async () => {
    const { c, calls } = client((u) => {
      if (u.includes("tenant_access_token")) return { body: TOKEN_BODY };
      return { body: { code: 0, data: { items: [], has_more: false } } };
    });
    await c.listAllSpaceNodes("spc");
    await c.listAllSpaceNodes("spc");
    expect(calls.filter((u) => u.includes("tenant_access_token")).length).toBe(1);
  });

  it("code!==0 → throw 含 code 与 msg", async () => {
    const { c } = client((u) =>
      u.includes("tenant_access_token")
        ? { body: TOKEN_BODY }
        : { body: { code: 1254005, msg: "not found" } }
    );
    await expect(c.getNode("x")).rejects.toThrow(/1254005.*not found/);
  });

  it("429 → 按 x-ogw-ratelimit-reset 退避重试后成功", async () => {
    let hits = 0;
    const { c } = client((u) => {
      if (u.includes("tenant_access_token")) return { body: TOKEN_BODY };
      hits++;
      if (hits <= 2) return { status: 429, headers: { "x-ogw-ratelimit-reset": "1" }, body: { code: 99991400 } };
      return { body: { code: 0, data: { node: { node_token: "n", obj_token: "o", obj_type: "docx", parent_node_token: "", title: "t", obj_edit_time: "1", has_child: false, space_id: "spc" } } } };
    });
    const r = await c.getNode("n");
    expect(r.node.node_token).toBe("n");
    expect(r.space_id).toBe("spc");
    expect(hits).toBe(3);
  });

  it("listAllSpaceNodes：分页 + 递归子节点，BFS 序", async () => {
    const top1 = { node_token: "A", obj_token: "oa", obj_type: "docx", parent_node_token: "", title: "A", obj_edit_time: "1", has_child: true };
    const top2 = { node_token: "B", obj_token: "ob", obj_type: "docx", parent_node_token: "", title: "B", obj_edit_time: "1", has_child: false };
    const kid = { node_token: "C", obj_token: "oc", obj_type: "docx", parent_node_token: "A", title: "C", obj_edit_time: "1", has_child: false };
    const { c } = client((u) => {
      if (u.includes("tenant_access_token")) return { body: TOKEN_BODY };
      if (u.includes("parent_node_token=A")) return { body: { code: 0, data: { items: [kid], has_more: false } } };
      if (u.includes("page_token=p2")) return { body: { code: 0, data: { items: [top2], has_more: false } } };
      return { body: { code: 0, data: { items: [top1], has_more: true, page_token: "p2" } } };
    });
    const nodes = await c.listAllSpaceNodes("spc");
    expect(nodes.map((n) => n.node_token)).toEqual(["A", "B", "C"]);
  });

  it("listDocBlocks 分页聚合", async () => {
    const b = (id: string) => ({ block_id: id, block_type: 2 });
    const { c } = client((u) => {
      if (u.includes("tenant_access_token")) return { body: TOKEN_BODY };
      if (u.includes("page_token=q2")) return { body: { code: 0, data: { items: [b("2")], has_more: false } } };
      return { body: { code: 0, data: { items: [b("1")], has_more: true, page_token: "q2" } } };
    });
    const blocks = await c.listDocBlocks("doc1");
    expect(blocks.map((x) => x.block_id)).toEqual(["1", "2"]);
  });
});
