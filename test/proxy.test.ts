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

  it("Responses 成功 SSE 保持原样", async () => {
    const body =
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n\n';
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const upstreamBody = upstream.body;

    const response = buildResponse(
      upstream,
      "https://demo.example.workers.dev/zen/go/v1/responses",
    );
    expect(response.body).toBe(upstreamBody);
    await expect(response.text()).resolves.toBe(body);
  });

  it("只规范化 Responses 中无法识别的上一响应失效错误", async () => {
    const body = JSON.stringify({
      model: "any-model",
      error: {
        type: "invalid_request_error",
        message:
          "Error from provider (Console Go): Upstream request failed: [invalid_request_error] referenced response not found or expired",
      },
    });
    const upstream = new Response(body, {
      status: 400,
      headers: { "content-type": "application/json", "content-length": String(body.length) },
    });

    const response = buildResponse(
      upstream,
      "https://demo.example.workers.dev/zen/go/v1/responses?trace=1",
    );
    const output = (await response.json()) as { error: { message: string } };

    expect(output.error.message).toContain(
      "previous_response_id: referenced response not found or expired",
    );
    expect(response.headers.has("content-length")).toBe(false);
  });

  it("上一响应失效提示跨越网络分块时仍能规范化", async () => {
    const parts = [
      '{"error":{"message":"referenced response ',
      'not found or expired"}}',
    ];
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts[index++];
        if (part === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(part));
      },
    });
    const upstream = new Response(body, {
      status: 400,
      headers: { "content-type": "application/json" },
    });

    const response = buildResponse(
      upstream,
      "https://demo.example.workers.dev/zen/go/v1/responses",
    );
    await expect(response.text()).resolves.toContain(
      "previous_response_id: referenced response not found or expired",
    );
  });

  it("Responses 的其他 400 错误正文保持原样", async () => {
    const body = '{ "error": { "message": "invalid image_url" } }';
    const upstream = new Response(body, {
      status: 400,
      headers: { "content-type": "application/json" },
    });

    const response = buildResponse(
      upstream,
      "https://demo.example.workers.dev/zen/go/v1/responses",
    );
    await expect(response.text()).resolves.toBe(body);
  });

  it("Responses 图片请求体字节级透传", async () => {
    const body = JSON.stringify({
      model: "muse-spark-1.2-contributor",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "描述图片" },
            { type: "input_image", image_url: "data:image/jpeg;base64,AA==" },
          ],
        },
      ],
      stream: true,
    });
    const incoming = new Request("https://demo.example.workers.dev/zen/go/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const upstream = buildUpstreamRequest(incoming);
    await expect(upstream.text()).resolves.toBe(body);
  });
});
