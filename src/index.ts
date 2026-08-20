import { repairSSE } from "./sse-repair";
import { repairRequestBody } from "./request-repair";
import { repairResponsesError } from "./response-repair";

const UPSTREAM_ORIGIN = "https://opencode.ai";
const API_PATH_PREFIXES = [
  "/zen/go/v1/chat/completions",
  "/zen/go/v1/messages",
  "/zen/go/v1/responses",
] as const;

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

function isAllowedAPIPath(pathname: string): boolean {
  for (const prefix of API_PATH_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function buildUpstreamRequest(request: Request, incomingURL = new URL(request.url)): Request {
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
    body: repairRequestBody(request),
    // 透传 ReadableStream body 时使用半双工请求，避免大请求体在标准 Fetch 实现中失败。
    duplex: "half",
    redirect: "manual",
  } as RequestInit);
}

function buildResponse(
  upstream: Response,
  requestURL: string,
  pathname = new URL(requestURL).pathname,
): Response {
  const headers = new Headers(upstream.headers);
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  const isChatSSE =
    upstream.ok &&
    contentType.includes("text/event-stream") &&
    upstream.body &&
    (pathname === API_PATH_PREFIXES[0] || pathname.startsWith(`${API_PATH_PREFIXES[0]}/`));
  const isResponsesStaleError =
    upstream.status === 400 &&
    contentType.includes("application/json") &&
    upstream.body &&
    pathname === API_PATH_PREFIXES[2];

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

  if (isResponsesStaleError) {
    // 正文可能增加兼容标识，不能继续使用上游长度。
    headers.delete("content-length");
    return new Response(repairResponsesError(upstream.body), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  if (!isChatSSE) {
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
    const incomingURL = new URL(request.url);
    // 在访问上游前拒绝官网和无关路径，根路径不会再代理出 OpenCode 页面。
    if (!isAllowedAPIPath(incomingURL.pathname)) return new Response(null, { status: 404 });

    const upstream = await fetch(buildUpstreamRequest(request, incomingURL));
    // incomingURL 已经解析过，直接传入路径可省去成功响应热路径上的重复 URL 解析。
    return buildResponse(upstream, request.url, incomingURL.pathname);
  },
} satisfies ExportedHandler;

export { buildResponse, buildUpstreamRequest, isAllowedAPIPath };
