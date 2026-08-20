import { describe, expect, it } from "vitest";
import { buildResponse, buildUpstreamRequest } from "../src/index";

describe("透明反向代理", () => {
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
