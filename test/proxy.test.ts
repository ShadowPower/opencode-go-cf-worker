import { describe, expect, it, vi } from "vitest";
import worker, { buildResponse, buildUpstreamRequest, isAllowedAPIPath } from "../src/index";

describe("透明反向代理", () => {
  it("只接受三个 OpenCode Go API 路径前缀", () => {
    expect(isAllowedAPIPath("/zen/go/v1/chat/completions")).toBe(true);
    expect(isAllowedAPIPath("/zen/go/v1/messages")).toBe(true);
    expect(isAllowedAPIPath("/zen/go/v1/responses")).toBe(true);
    expect(isAllowedAPIPath("/zen/go/v1/responses/stream")).toBe(true);

    expect(isAllowedAPIPath("/")).toBe(false);
    expect(isAllowedAPIPath("/favicon.ico")).toBe(false);
    expect(isAllowedAPIPath("/zen/go/v1/models")).toBe(false);
    expect(isAllowedAPIPath("/zen/go/v1/chat/completions-unknown")).toBe(false);
  });

  it("无关路径直接返回 404，不访问上游", async () => {
    const upstreamFetch = vi.fn();
    vi.stubGlobal("fetch", upstreamFetch);
    try {
      const response = await worker.fetch(new Request("https://demo.example.workers.dev/"));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
      expect(upstreamFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("只替换域名并保留路径和查询参数", () => {
    const incoming = new Request("https://demo.example.workers.dev/zen/go/v1/chat/completions?trace=1", {
      headers: {
        authorization: "Bearer secret",
        "cf-connecting-ip": "203.0.113.10",
        "x-forwarded-for": "203.0.113.10",
      },
    });
    const upstream = buildUpstreamRequest(incoming);

    expect(upstream.url).toBe("https://opencode.ai/zen/go/v1/chat/completions?trace=1");
    expect(upstream.headers.get("authorization")).toBe("Bearer secret");
    expect(upstream.headers.has("cf-connecting-ip")).toBe(false);
    expect(upstream.headers.has("x-forwarded-for")).toBe(false);
    expect(upstream.headers.get("origin")).toBe("https://opencode.ai");
  });

  it("不透传会破坏流式请求体的代理头", () => {
    const incoming = new Request("https://demo.example.workers.dev/zen/go/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }],
      }),
      headers: {
        "content-length": "999999",
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    });
    const upstream = buildUpstreamRequest(incoming);

    expect(upstream.headers.get("content-type")).toBe("application/json");
    expect(upstream.headers.has("content-length")).toBe(false);
    expect(upstream.headers.has("transfer-encoding")).toBe(false);
  });

  it("改写上游重定向域名", async () => {
    const upstream = new Response(null, {
      status: 302,
      headers: { location: "https://opencode.ai/zen/go/v1/models?page=2" },
    });
    const response = buildResponse(upstream, "https://demo.example.workers.dev/zen/go/v1/models");
    expect(response.headers.get("location")).toBe("https://demo.example.workers.dev/zen/go/v1/models?page=2");
  });

  it("非 SSE 响应不经过转换", async () => {
    const upstream = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json", "x-upstream": "yes" },
    });
    const response = buildResponse(upstream, "https://demo.example.workers.dev/zen/go/v1/models");
    expect(await response.text()).toBe('{"ok":true}');
    expect(response.headers.get("x-upstream")).toBe("yes");
  });
});
