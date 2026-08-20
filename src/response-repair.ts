type JSONObject = Record<string, unknown>;

const MAX_ERROR_BYTES = 16 * 1024;
const STALE_RESPONSE_MESSAGE = "referenced response not found or expired";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isRecord(value: unknown): value is JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeErrorBody(bytes: Uint8Array): Uint8Array | undefined {
  const text = decoder.decode(bytes);
  // 绝大多数 400 与该问题无关，先做廉价精确匹配，避免无谓 JSON 解析。
  if (!text.includes(STALE_RESPONSE_MESSAGE)) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") {
    return undefined;
  }

  const message = value.error.message;
  const lower = message.toLowerCase();
  const staleAt = lower.indexOf(STALE_RESPONSE_MESSAGE);
  if (staleAt < 0) return undefined;

  // 已经能被常见客户端识别时保持原文，避免重复添加兼容标识。
  if (
    lower.includes("previous_response_id") ||
    lower.includes("previous response") ||
    lower.includes("response id")
  ) {
    return undefined;
  }

  value.error.message =
    message.slice(0, staleAt) + "previous_response_id: " + message.slice(staleAt);
  return encoder.encode(JSON.stringify(value));
}

class ResponsesErrorTransformer implements Transformer<Uint8Array, Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private byteLength = 0;
  private passthrough = false;

  transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.passthrough) {
      controller.enqueue(chunk);
      return;
    }

    if (this.byteLength + chunk.byteLength > MAX_ERROR_BYTES) {
      // 异常大的错误正文不解析；释放已暂存数据后直接流式透传。
      for (const held of this.chunks) controller.enqueue(held);
      this.chunks.length = 0;
      controller.enqueue(chunk);
      this.passthrough = true;
      return;
    }

    this.chunks.push(chunk);
    this.byteLength += chunk.byteLength;
  }

  flush(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.passthrough || this.byteLength === 0) return;

    const body = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    controller.enqueue(normalizeErrorBody(body) ?? body);
  }
}

/**
 * 仅规范化 Responses API 的小型失效响应，让客户端触发自己的完整历史重试。
 * 最多暂存 16 KiB；其他错误正文逐字节保持不变。
 */
export function repairResponsesError(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return source.pipeThrough(new TransformStream(new ResponsesErrorTransformer()));
}
