const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;
const CONTENT_PART_DEPTH = 5;
const MAX_CAPTURE_BYTES = 128;
const MAX_CANDIDATE_BYTES = 4096;

const encoder = new TextEncoder();
const IMAGE_URL_KEY = encoder.encode("image_url");
const URL_KEY = encoder.encode("url");
const REPAIRED_PREFIX = encoder.encode('"image_url":"');

type Mode = "detect" | "pass" | "scan" | "key" | "prefix" | "object" | "url" | "skip" | "candidate-pass";

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function equalsBytes(value: number[], expected: Uint8Array): boolean {
  if (value.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (value[index] !== expected[index]) return false;
  }
  return true;
}

function isMuseModel(value: number[], valid: boolean): boolean {
  if (!valid || value.length < 4) return false;
  const lower = (byte: number): number => (byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);
  return (
    lower(value[0]!) === 0x6d &&
    lower(value[1]!) === 0x75 &&
    lower(value[2]!) === 0x73 &&
    lower(value[3]!) === 0x65 &&
    (value.length === 4 || value[4] === 0x2d)
  );
}

function shouldRepairRequest(request: Request): boolean {
  if (request.method !== "POST" || !request.body) return false;
  const url = new URL(request.url);
  return (
    url.pathname.endsWith("/chat/completions") &&
    (request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")
  );
}

/**
 * 只检查 JSON 的结构字节，普通内容始终按原始 Uint8Array 输出。
 * 非 Muse 请求确认 model 后立即零拷贝透传；大图片和长文本用原生 indexOf 跳过。
 */
class MuseRequestTransformer implements Transformer<Uint8Array, Uint8Array> {
  private mode: Mode = "detect";

  // 顶层 model 探测状态，嵌套对象里的同名字段不会命中。
  private detectDepth = 0;
  private detectState: "start" | "key" | "colon" | "value" | "after" = "start";
  private detectInString = false;
  private detectEscape = false;
  private detectRole: "key" | "model" | "other" = "other";
  private detectKeyIsModel = false;
  private detectCapture: number[] = [];
  private detectCaptureValid = true;

  // Muse 请求扫描状态。标准 messages[].content[] 项位于第五层容器。
  private depth = 1;
  private inString = false;
  private stringEscape = false;

  // image_url 候选只暂存 URL 之前的小段结构，绝不缓存图片数据。
  private held: number[] = [];
  private keyIndex = 0;
  private prefixStage: "colon" | "value" = "colon";
  private candidateDepth = 0;
  private candidateInString = false;
  private candidateEscape = false;
  private candidateReadingKey = false;
  private candidateExpectKey = true;
  private candidateKey: number[] = [];
  private candidateKeyValid = true;
  private candidateUrlStage: "none" | "colon" | "value" = "none";
  private urlEscape = false;

  transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.mode === "pass") {
      controller.enqueue(chunk);
      return;
    }

    if (this.mode === "detect") {
      const start = this.detectModel(chunk);
      if (start === null) {
        controller.enqueue(chunk);
        return;
      }
      if (start > 0) controller.enqueue(chunk.subarray(0, start));
      if (start < chunk.byteLength) this.processMuse(chunk, start, controller);
      return;
    }

    this.processMuse(chunk, 0, controller);
  }

  flush(controller: TransformStreamDefaultController<Uint8Array>): void {
    // 未确认并开始改写的候选原样退回；完整合法 JSON 不会走到这个分支。
    if (this.held.length && (this.mode === "key" || this.mode === "prefix" || this.mode === "object")) {
      controller.enqueue(Uint8Array.from(this.held));
      this.held = [];
    }
  }

  /** 命中时返回 Muse model 字符串结束后的偏移。 */
  private detectModel(chunk: Uint8Array): number | null {
    for (let index = 0; index < chunk.byteLength; index++) {
      if (this.detectInString && this.detectRole === "other") {
        const end = this.findStringEnd(chunk, index, this.detectEscape);
        this.detectEscape = end.escaped;
        if (end.index < 0) return null;
        this.detectInString = false;
        index = end.index;
        continue;
      }

      const byte = chunk[index]!;
      if (this.detectInString) {
        if (this.detectEscape) {
          this.detectEscape = false;
          this.detectCaptureValid = false;
          continue;
        }
        if (byte === BACKSLASH) {
          this.detectEscape = true;
          continue;
        }
        if (byte !== QUOTE) {
          if (this.detectCapture.length < MAX_CAPTURE_BYTES) this.detectCapture.push(byte);
          else this.detectCaptureValid = false;
          continue;
        }

        this.detectInString = false;
        if (this.detectRole === "key") {
          this.detectKeyIsModel =
            this.detectCaptureValid &&
            this.detectCapture.length === 5 &&
            this.detectCapture[0] === 0x6d &&
            this.detectCapture[1] === 0x6f &&
            this.detectCapture[2] === 0x64 &&
            this.detectCapture[3] === 0x65 &&
            this.detectCapture[4] === 0x6c;
          this.detectState = "colon";
        } else if (this.detectRole === "model") {
          if (isMuseModel(this.detectCapture, this.detectCaptureValid)) {
            this.mode = "scan";
            this.depth = 1;
            return index + 1;
          }
          this.mode = "pass";
          return null;
        }
        continue;
      }

      if (isWhitespace(byte)) continue;
      if (this.detectDepth === 0) {
        if (byte === OPEN_OBJECT) {
          this.detectDepth = 1;
          this.detectState = "key";
        }
        continue;
      }
      if (this.detectDepth === 1 && this.detectState === "key" && byte === QUOTE) {
        this.startDetectString("key");
        continue;
      }
      if (this.detectDepth === 1 && this.detectState === "colon" && byte === COLON) {
        this.detectState = "value";
        continue;
      }
      if (this.detectDepth === 1 && this.detectState === "value") {
        if (this.detectKeyIsModel) {
          if (byte !== QUOTE) {
            this.mode = "pass";
            return null;
          }
          this.startDetectString("model");
          continue;
        }
        this.detectState = "after";
        if (byte === QUOTE) {
          this.startDetectString("other");
          continue;
        }
      } else if (byte === QUOTE) {
        this.startDetectString("other");
        continue;
      }

      if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) this.detectDepth++;
      else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
        this.detectDepth--;
        if (this.detectDepth === 0) {
          this.mode = "pass";
          return null;
        }
      } else if (byte === COMMA && this.detectDepth === 1) {
        this.detectState = "key";
        this.detectKeyIsModel = false;
      }
    }
    return null;
  }

  private startDetectString(role: "key" | "model" | "other"): void {
    this.detectInString = true;
    this.detectEscape = false;
    this.detectRole = role;
    this.detectCapture = [];
    this.detectCaptureValid = true;
  }

  private processMuse(chunk: Uint8Array, offset: number, controller: TransformStreamDefaultController<Uint8Array>): void {
    let emitStart = offset;

    for (let index = offset; index < chunk.byteLength; index++) {
      if (this.mode === "url") {
        const end = this.findStringEnd(chunk, index, this.urlEscape);
        this.urlEscape = end.escaped;
        if (end.index < 0) break;
        controller.enqueue(chunk.subarray(emitStart, end.index + 1));
        emitStart = end.index + 1;
        this.mode = "skip";
        this.candidateInString = false;
        this.candidateEscape = false;
        index = end.index;
        continue;
      }
      if (this.mode === "scan" && this.inString) {
        const end = this.findStringEnd(chunk, index, this.stringEscape);
        this.stringEscape = end.escaped;
        if (end.index < 0) break;
        this.inString = false;
        index = end.index;
        continue;
      }

      const byte = chunk[index]!;
      if (this.mode === "key") {
        this.held.push(byte);
        emitStart = index + 1;
        this.consumeCandidateKey(byte, controller);
        continue;
      }
      if (this.mode === "prefix") {
        this.held.push(byte);
        emitStart = index + 1;
        this.consumeCandidatePrefix(byte, controller);
        continue;
      }
      if (this.mode === "object") {
        this.held.push(byte);
        emitStart = index + 1;
        this.consumeCandidateObject(byte, controller);
        continue;
      }
      if (this.mode === "skip") {
        emitStart = index + 1;
        if (this.consumeCandidateRemainder(byte)) this.finishCandidate();
        continue;
      }
      if (this.mode === "candidate-pass") {
        if (this.consumeCandidateRemainder(byte)) this.finishCandidate();
        continue;
      }

      if (byte === QUOTE) {
        if (this.depth === CONTENT_PART_DEPTH) {
          if (emitStart < index) controller.enqueue(chunk.subarray(emitStart, index));
          this.held = [QUOTE];
          this.keyIndex = 0;
          this.mode = "key";
          emitStart = index + 1;
        } else {
          this.inString = true;
          this.stringEscape = false;
        }
      } else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
        this.depth++;
      } else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
        this.depth--;
        if (this.depth === 0) this.mode = "pass";
      }
    }

    if (emitStart < chunk.byteLength && this.outputsRawBytes()) controller.enqueue(chunk.subarray(emitStart));
  }

  private consumeCandidateKey(byte: number, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (byte === BACKSLASH) {
      this.flushHeld(controller);
      this.mode = "scan";
      this.inString = true;
      this.stringEscape = true;
      return;
    }
    if (byte === QUOTE) {
      if (this.keyIndex === IMAGE_URL_KEY.length) {
        this.prefixStage = "colon";
        this.mode = "prefix";
      } else {
        this.flushHeld(controller);
        this.mode = "scan";
      }
      return;
    }
    if (this.keyIndex >= IMAGE_URL_KEY.length || byte !== IMAGE_URL_KEY[this.keyIndex]) {
      this.flushHeld(controller);
      this.mode = "scan";
      this.inString = true;
      this.stringEscape = false;
      return;
    }
    this.keyIndex++;
  }

  private consumeCandidatePrefix(byte: number, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (isWhitespace(byte)) return;
    if (this.prefixStage === "colon") {
      if (byte === COLON) {
        this.prefixStage = "value";
        return;
      }
      this.rejectCandidatePrefix(byte, controller);
      return;
    }
    if (byte === OPEN_OBJECT) {
      this.mode = "object";
      this.candidateDepth = 1;
      this.candidateInString = false;
      this.candidateEscape = false;
      this.candidateExpectKey = true;
      this.candidateReadingKey = false;
      this.candidateUrlStage = "none";
      return;
    }
    this.rejectCandidatePrefix(byte, controller);
  }

  private rejectCandidatePrefix(byte: number, controller: TransformStreamDefaultController<Uint8Array>): void {
    this.flushHeld(controller);
    this.mode = "scan";
    if (byte === QUOTE) {
      this.inString = true;
      this.stringEscape = false;
    } else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
      this.depth++;
    } else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
      this.depth--;
    }
  }

  private consumeCandidateObject(byte: number, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.candidateInString) {
      if (this.candidateEscape) {
        this.candidateEscape = false;
        if (this.candidateReadingKey) this.candidateKeyValid = false;
        return this.checkCandidateLimit(controller);
      }
      if (byte === BACKSLASH) {
        this.candidateEscape = true;
        return this.checkCandidateLimit(controller);
      }
      if (byte !== QUOTE) {
        if (this.candidateReadingKey) {
          if (this.candidateKey.length < 16) this.candidateKey.push(byte);
          else this.candidateKeyValid = false;
        }
        return this.checkCandidateLimit(controller);
      }

      this.candidateInString = false;
      if (this.candidateReadingKey) {
        this.candidateUrlStage = this.candidateKeyValid && equalsBytes(this.candidateKey, URL_KEY) ? "colon" : "none";
        this.candidateReadingKey = false;
        this.candidateExpectKey = false;
      }
      return this.checkCandidateLimit(controller);
    }

    if (this.candidateDepth === 1 && this.candidateUrlStage === "colon") {
      if (isWhitespace(byte)) return this.checkCandidateLimit(controller);
      if (byte === COLON) {
        this.candidateUrlStage = "value";
        return this.checkCandidateLimit(controller);
      }
      return this.flushHeldToCandidatePass(controller);
    }
    if (this.candidateDepth === 1 && this.candidateUrlStage === "value") {
      if (isWhitespace(byte)) return this.checkCandidateLimit(controller);
      if (byte === QUOTE) {
        controller.enqueue(REPAIRED_PREFIX);
        this.held = [];
        this.mode = "url";
        this.urlEscape = false;
        return;
      }
      if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) this.candidateDepth++;
      return this.flushHeldToCandidatePass(controller);
    }

    if (this.candidateDepth === 1 && this.candidateExpectKey) {
      if (isWhitespace(byte)) return this.checkCandidateLimit(controller);
      if (byte === CLOSE_OBJECT) {
        this.flushHeld(controller);
        this.finishCandidate();
        return;
      }
      if (byte === QUOTE) {
        this.candidateInString = true;
        this.candidateEscape = false;
        this.candidateReadingKey = true;
        this.candidateKey = [];
        this.candidateKeyValid = true;
        return this.checkCandidateLimit(controller);
      }
      return this.flushHeldToCandidatePass(controller);
    }

    if (byte === QUOTE) {
      this.candidateInString = true;
      this.candidateEscape = false;
      this.candidateReadingKey = false;
    } else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
      this.candidateDepth++;
    } else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
      this.candidateDepth--;
      if (this.candidateDepth === 0) {
        this.flushHeld(controller);
        this.finishCandidate();
        return;
      }
    } else if (byte === COMMA && this.candidateDepth === 1) {
      this.candidateExpectKey = true;
      this.candidateUrlStage = "none";
    }
    this.checkCandidateLimit(controller);
  }

  private checkCandidateLimit(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.held.length > MAX_CANDIDATE_BYTES) this.flushHeldToCandidatePass(controller);
  }

  private flushHeldToCandidatePass(controller: TransformStreamDefaultController<Uint8Array>): void {
    this.flushHeld(controller);
    this.mode = "candidate-pass";
  }

  private flushHeld(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.held.length) controller.enqueue(Uint8Array.from(this.held));
    this.held = [];
  }

  /** 跳过或透传 image_url 包裹对象中 URL 之外的字段。 */
  private consumeCandidateRemainder(byte: number): boolean {
    if (this.candidateInString) {
      if (this.candidateEscape) this.candidateEscape = false;
      else if (byte === BACKSLASH) this.candidateEscape = true;
      else if (byte === QUOTE) this.candidateInString = false;
      return false;
    }
    if (byte === QUOTE) this.candidateInString = true;
    else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) this.candidateDepth++;
    else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
      this.candidateDepth--;
      return this.candidateDepth === 0;
    }
    return false;
  }

  private finishCandidate(): void {
    this.mode = "scan";
    this.candidateInString = false;
    this.candidateEscape = false;
  }

  private findStringEnd(
    chunk: Uint8Array,
    start: number,
    escapedFromPreviousChunk: boolean,
  ): { index: number; escaped: boolean } {
    let offset = start;
    if (escapedFromPreviousChunk) offset++;
    while (offset < chunk.byteLength) {
      const quote = chunk.indexOf(QUOTE, offset);
      const backslash = chunk.indexOf(BACKSLASH, offset);
      if (quote < 0 && backslash < 0) return { index: -1, escaped: false };
      if (backslash >= 0 && (quote < 0 || backslash < quote)) {
        if (backslash + 1 >= chunk.byteLength) return { index: -1, escaped: true };
        offset = backslash + 2;
      } else {
        return { index: quote, escaped: false };
      }
    }
    return { index: -1, escaped: false };
  }

  private outputsRawBytes(): boolean {
    return this.mode === "scan" || this.mode === "url" || this.mode === "candidate-pass" || this.mode === "pass";
  }
}

export function repairRequestBody(request: Request): BodyInit | null {
  if (!shouldRepairRequest(request)) return request.body;
  return request.body!.pipeThrough(new TransformStream(new MuseRequestTransformer()));
}
