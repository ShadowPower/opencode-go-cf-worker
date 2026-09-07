import { repairSSE } from "./sse-repair";
import { repairRequestBody } from "./request-repair";
import { repairResponsesError } from "./response-repair";

const UPSTREAM_ORIGIN = "https://opencode.ai";
const API_BASE_PATH = "/zen/go/v1";
const CHAT_COMPLETIONS_PATH = "/zen/go/v1/chat/completions";
const MESSAGES_PATH = "/zen/go/v1/messages";
const RESPONSES_PATH = "/zen/go/v1/responses";

const PRIVATE_HEADERS = [
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "cf-pseudo-ipv4",
  "cf-ipcountry",
  "cf-ray",
  "cf-worker",
  "cf-ew-via",
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
  // 放行 /zen/go/v1 下所有子路径，兼容上游新增端点（如 models、未来新路径）。
  return pathname === API_BASE_PATH || pathname.startsWith(`${API_BASE_PATH}/`);
}

function corsHeaders(request?: Request): Headers {
  const headers = new Headers();
  // 上游对 OPTIONS 直接返回 404 HTML，且实际响应缺少 ACAO，
  // 浏览器客户端会被 CORS 拦截。Worker 侧统一补齐，透传逻辑不受影响。
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-max-age", "86400");
  const requested =
    request?.headers.get("access-control-request-headers") ??
    request?.headers.get("Access-Control-Request-Headers");
  headers.set(
    "access-control-allow-headers",
    requested?.trim()
      ? requested
      : "Authorization, Content-Type, x-api-key, anthropic-version, x-opencode-session",
  );
  headers.set("vary", "Origin, Access-Control-Request-Headers");
  return headers;
}

function withCORS(response: Response, request?: Request): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(request)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function workerNotFound(request: Request, incomingURL: URL): Response {
  // Worker 自身拦截时返回 JSON，便于和上游 HTML 404 区分。
  const body = JSON.stringify({
    error: {
      type: "not_found",
      message: `Path ${incomingURL.pathname} is not proxied. Use ${API_BASE_PATH}/*`,
    },
  });
  const headers = corsHeaders(request);
  headers.set("content-type", "application/json");
  return new Response(body, { status: 404, headers });
}

function buildUpstreamRequest(request: Request, incomingURL = new URL(request.url)): Request {
  const upstreamURL = new URL(incomingURL.pathname + incomingURL.search, UPSTREAM_ORIGIN);
  const headers = new Headers(request.headers);

  // 不向上游泄露 Cloudflare 注入的客户端网络信息和派生 IP 头。
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
    (pathname === CHAT_COMPLETIONS_PATH || pathname.startsWith(`${CHAT_COMPLETIONS_PATH}/`));
  const isResponsesStaleError =
    upstream.status === 400 &&
    contentType.includes("application/json") &&
    upstream.body &&
    pathname === RESPONSES_PATH;

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
    // 上游对 OPTIONS 返回 404 HTML，这里直接在 Worker 侧回答预检，避免转发 404。
    if (request.method === "OPTIONS") {
      if (!isAllowedAPIPath(incomingURL.pathname)) return workerNotFound(request, incomingURL);
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    // 在访问上游前拒绝官网和无关路径，根路径不会再代理出 OpenCode 页面。
    if (!isAllowedAPIPath(incomingURL.pathname)) return workerNotFound(request, incomingURL);

    const upstream = await fetch(buildUpstreamRequest(request, incomingURL));
    // incomingURL 已经解析过，直接传入路径可省去成功响应热路径上的重复 URL 解析。
    // 上游实际响应缺少 CORS 头，统一补齐后浏览器才能读取。
    return withCORS(buildResponse(upstream, request.url, incomingURL.pathname), request);
  },
} satisfies ExportedHandler;

export { buildResponse, buildUpstreamRequest, isAllowedAPIPath };
