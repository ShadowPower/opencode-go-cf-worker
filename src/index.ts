import { repairSSE } from "./sse-repair";

const UPSTREAM_ORIGIN = "https://opencode.ai";

const PRIVATE_HEADERS = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "forwarded",
  "true-client-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
  "x-cluster-client-ip",
  "x-client-ip",
  "via",
];

const PROXY_HEADERS = [
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function buildUpstreamRequest(request: Request): Request {
  const incomingURL = new URL(request.url);
  const upstreamURL = new URL(incomingURL.pathname + incomingURL.search, UPSTREAM_ORIGIN);
  const headers = new Headers(request.headers);

  // 不向上游泄露 Cloudflare 注入的客户端网络信息。
  for (const name of PRIVATE_HEADERS) headers.delete(name);
  // 请求体由 Workers 运行时重新发送，长度和逐跳头不能从客户端原样透传。
  for (const name of PROXY_HEADERS) headers.delete(name);
  headers.delete("host");
  headers.set("accept-encoding", "identity");
  headers.set("origin", UPSTREAM_ORIGIN);
  headers.set("referer", `${UPSTREAM_ORIGIN}/`);

  return new Request(upstreamURL, {
    method: request.method,
    headers,
    body: request.body,
    // 透传 ReadableStream body 时使用半双工请求，避免大请求体在标准 Fetch 实现中失败。
    duplex: "half",
    redirect: "manual",
  } as RequestInit);
}

function buildResponse(upstream: Response, requestURL: string): Response {
  const headers = new Headers(upstream.headers);
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  const isSSE = upstream.ok && contentType.includes("text/event-stream") && upstream.body;

  // Location 指向上游时改回当前 Worker，保证调用方只需替换域名。
  const location = headers.get("location");
  if (location) {
    try {
      const resolved = new URL(location, UPSTREAM_ORIGIN);
      if (resolved.origin === UPSTREAM_ORIGIN) {
        const workerOrigin = new URL(requestURL).origin;
        headers.set("location", workerOrigin + resolved.pathname + resolved.search + resolved.hash);
      }
    } catch {
      // 非标准 Location 原样返回，不能让无关的上游头导致整个请求失败。
    }
  }

  if (!isSSE) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // 内容经过流式转换后长度未知；其余缓存和内容类型头保持上游语义。
  headers.delete("content-length");
  return new Response(repairSSE(upstream.body), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const upstream = await fetch(buildUpstreamRequest(request));
    return buildResponse(upstream, request.url);
  },
} satisfies ExportedHandler;

export { buildResponse, buildUpstreamRequest };
