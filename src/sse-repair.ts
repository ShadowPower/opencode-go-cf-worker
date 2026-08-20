interface ChoiceState {
  index: number;
  finished: boolean;
  finishReason: "stop" | "tool_calls" | "function_call";
}

type JSONObject = Record<string, unknown>;

const encoder = new TextEncoder();

function isRecord(value: unknown): value is JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventData(raw: string): string | undefined {
  // OpenCode 的正常帧都是单行 data；先走无数组分配的热路径。
  if (raw.startsWith("data:")) {
    const lineEnd = raw.indexOf("\n");
    if (lineEnd >= 0) {
      const rest = raw.slice(lineEnd + 1);
      if (rest === "\n" || rest === "\r\n" || rest === "") {
        let data = raw.slice(5, lineEnd);
        if (data.endsWith("\r")) data = data.slice(0, -1);
        if (data.startsWith(" ")) data = data.slice(1);
        return data.trim();
      }
    }
  }

  // 保留对注释、多行 data 和不同换行格式的完整 SSE 兼容。
  const values: string[] = [];
  for (const line of raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    if (line === "data") values.push("");
    else if (line.startsWith("data:")) values.push(line.slice(5).replace(/^ /, ""));
  }
  return values.length === 0 ? undefined : values.join("\n").trim();
}

function parseObject(data: string | undefined): JSONObject | undefined {
  if (data === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(data);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function newlineOf(raw: string): "\n" | "\r\n" {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function serialize(value: JSONObject, newline = "\n"): string {
  return `data: ${JSON.stringify(value)}${newline}${newline}`;
}

function isAffectedModel(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const model = value.toLowerCase();
  return (
    model === "muse" ||
    model.startsWith("muse-") ||
    model === "gpt-5.6-luna" ||
    model.startsWith("gpt-5.6-luna-") ||
    model === "kimi-k3" ||
    model.startsWith("kimi-k3-")
  );
}

function eventEnd(buffer: string, from: number): { index: number; length: number } | undefined {
  // 直接比较三个下标，避免每个事件创建数组和执行排序。
  const crlf = buffer.indexOf("\r\n\r\n", from);
  const lf = buffer.indexOf("\n\n", from);
  const cr = buffer.indexOf("\r\r", from);
  let index = -1;
  let length = 2;
  if (crlf >= 0) {
    index = crlf;
    length = 4;
  }
  if (lf >= 0 && (index < 0 || lf < index)) {
    index = lf;
    length = 2;
  }
  if (cr >= 0 && (index < 0 || cr < index)) {
    index = cr;
    length = 2;
  }
  return index < 0 ? undefined : { index, length };
}

class SSERepairTransformer implements Transformer<Uint8Array, Uint8Array> {
  private readonly decoder = new TextDecoder();
  private readonly choices = new Map<number, ChoiceState>();
  private readonly metadata: JSONObject = {};
  private buffer = "";
  private searchFrom = 0;
  private pendingUsage = "";
  private outputTail = "";
  private sawChatChunk = false;
  private sawDone = false;
  private hasCompletionEvidence = false;

  transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.drain(controller);
  }

  flush(controller: TransformStreamDefaultController<Uint8Array>): void {
    this.buffer += this.decoder.decode();
    this.drain(controller);
    if (this.buffer) {
      this.handleEvent(this.buffer, controller);
      this.buffer = "";
    }
    this.finish(controller);
  }

  private drain(controller: TransformStreamDefaultController<Uint8Array>): void {
    for (;;) {
      const end = eventEnd(this.buffer, this.searchFrom);
      if (!end) {
        // 下次只回看最长分隔符可能跨越的三个字符，避免 O(n²) 重扫。
        this.searchFrom = Math.max(0, this.buffer.length - 3);
        return;
      }
      const length = end.index + end.length;
      const raw = this.buffer.slice(0, length);
      this.buffer = this.buffer.slice(length);
      this.searchFrom = 0;
      this.handleEvent(raw, controller);
    }
  }

  private handleEvent(raw: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    const data = eventData(raw);
    if (data === "[DONE]") {
      if (!this.sawDone && this.unfinishedChoices().length > 0) {
        this.write(this.terminalEvent(newlineOf(raw)), controller);
        this.markFinished();
      }
      this.emitUsage(controller);
      this.sawDone = true;
      this.write(raw, controller);
      return;
    }

    const value = parseObject(data);
    if (this.sawChatChunk && this.isCostTail(value)) {
      this.hasCompletionEvidence = true;
      return;
    }

    const choices = Array.isArray(value?.choices) ? value.choices : undefined;
    const isChatChunk = choices !== undefined && value?.object === "chat.completion.chunk";
    const isUsageChunk =
      this.sawChatChunk && choices?.length === 0 && isRecord(value?.usage);

    if (value && choices && (isChatChunk || isUsageChunk)) {
      this.handleChatChunk(value, choices, raw, controller);
      return;
    }
    this.emitUsage(controller);
    this.write(raw, controller);
  }

  private handleChatChunk(
    chunk: JSONObject,
    choices: unknown[],
    raw: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    this.sawChatChunk = true;
    this.rememberMetadata(chunk);
    let changed = this.fillMetadata(chunk);

    if (choices.length === 0) {
      // 空 choices 只有携带 usage 时才是 OpenAI 兼容帧。
      if (!isRecord(chunk.usage)) return;
      this.hasCompletionEvidence = true;
      if ("cost" in chunk) {
        delete chunk.cost;
        changed = true;
      }
      this.emitUsage(controller);
      this.pendingUsage = changed ? serialize(chunk, newlineOf(raw)) : raw;
      return;
    }

    let finishesChoice = false;
    for (let position = 0; position < choices.length; position++) {
      const choice = choices[position];
      if (!isRecord(choice)) continue;
      const index = typeof choice.index === "number" ? choice.index : position;
      const previous = this.choices.get(index);
      let finishReason = previous?.finishReason ?? "stop";
      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      if (delta) {
        if ("tool_calls" in delta) finishReason = "tool_calls";
        if ("function_call" in delta) finishReason = "function_call";
        if (!previous && typeof choice.finish_reason !== "string" && typeof delta.role !== "string") {
          delta.role = "assistant";
          changed = true;
        }
      }
      const finished =
        previous?.finished === true ||
        (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0);
      this.choices.set(index, { index, finished, finishReason });
      finishesChoice ||= finished;
    }

    if (finishesChoice) this.hasCompletionEvidence = true;
    else this.emitUsage(controller);
    this.write(changed ? serialize(chunk, newlineOf(raw)) : raw, controller);
  }

  private finish(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.sawDone || !this.sawChatChunk) {
      this.emitUsage(controller);
      return;
    }
    const unfinished = this.unfinishedChoices();
    const canInfer = this.hasCompletionEvidence || isAffectedModel(this.metadata.model);
    if ((!canInfer && unfinished.length > 0) || (!canInfer && this.choices.size === 0)) {
      this.emitUsage(controller);
      return;
    }
    if (unfinished.length > 0) {
      this.write(this.separator() + this.terminalEvent(), controller);
      this.markFinished();
    }
    this.emitUsage(controller);
    this.write(this.separator() + "data: [DONE]\n\n", controller);
  }

  private terminalEvent(newline = "\n"): string {
    const chunk: JSONObject = { object: "chat.completion.chunk" };
    for (const key of ["id", "created", "model", "system_fingerprint"]) {
      if (key in this.metadata) chunk[key] = this.metadata[key];
    }
    chunk.choices = this.unfinishedChoices().map((choice) => ({
      index: choice.index,
      delta: {},
      finish_reason: choice.finishReason,
    }));
    return serialize(chunk, newline);
  }

  private rememberMetadata(chunk: JSONObject): void {
    if (typeof chunk.id === "string" && chunk.id) this.metadata.id = chunk.id;
    if (typeof chunk.model === "string" && chunk.model) this.metadata.model = chunk.model;
    for (const key of ["created", "system_fingerprint"]) {
      if (key in chunk && chunk[key] !== "" && chunk[key] != null) this.metadata[key] = chunk[key];
    }
  }

  private fillMetadata(chunk: JSONObject): boolean {
    let changed = false;
    for (const key of ["id", "model"]) {
      if ((typeof chunk[key] !== "string" || chunk[key] === "") && key in this.metadata) {
        chunk[key] = this.metadata[key];
        changed = true;
      }
    }
    for (const key of ["created", "system_fingerprint"]) {
      if (!(key in chunk) && key in this.metadata) {
        chunk[key] = this.metadata[key];
        changed = true;
      }
    }
    if (chunk.object !== "chat.completion.chunk") {
      chunk.object = "chat.completion.chunk";
      changed = true;
    }
    return changed;
  }

  private isCostTail(value: JSONObject | undefined): boolean {
    return Boolean(
      value && Array.isArray(value.choices) && value.choices.length === 0 && "cost" in value && !isRecord(value.usage),
    );
  }

  private unfinishedChoices(): ChoiceState[] {
    return [...this.choices.values()].filter((choice) => !choice.finished).sort((a, b) => a.index - b.index);
  }

  private markFinished(): void {
    for (const choice of this.choices.values()) choice.finished = true;
  }

  private emitUsage(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (!this.pendingUsage) return;
    const usage = this.pendingUsage;
    this.pendingUsage = "";
    this.write(usage, controller);
  }

  private separator(): string {
    if (this.outputTail.endsWith("\n\n") || this.outputTail.endsWith("\r\n\r\n")) return "";
    return this.outputTail.endsWith("\n") ? "\n" : "\n\n";
  }

  private write(value: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (!value) return;
    controller.enqueue(encoder.encode(value));
    this.outputTail = (this.outputTail + value).slice(-4);
  }
}

/**
 * 逐事件修复 SSE。TransformStream 会自动传递背压，且每个请求只保留一个未完成事件，
 * 不会因为长回答占用持续增长的内存。
 */
export function repairSSE(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return source.pipeThrough(new TransformStream(new SSERepairTransformer()));
}
