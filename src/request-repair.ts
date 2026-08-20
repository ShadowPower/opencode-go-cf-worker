const PROBE_BYTES = 256 * 1024;
const encoder = new TextEncoder();

function isMuseModelPrefix(value: string): boolean {
  return /"model"\s*:\s*"muse(?:-|")/i.test(value);
}

function hasImageUrlObject(value: string): boolean {
  return /"image_url"\s*:\s*\{\s*"url"\s*:/i.test(value);
}

function shouldProbeRequest(request: Request): boolean {
  if (request.method !== "POST" || !request.body) return false;
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/chat/completions")) return false;
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/json");
}

class ImageUrlRepairTransformer implements Transformer<Uint8Array, Uint8Array> {
  private readonly decoder = new TextDecoder();
  private probe = "";
  private probeBytes = 0;
  private buffer = "";
  private mode: "probe" | "repair" | "pass" = "probe";
  private state: "normal" | "url" | "object-end" = "normal";
  private urlStarted = false;

  transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.mode === "pass") {
      controller.enqueue(chunk);
      return;
    }

    const text = this.decoder.decode(chunk, { stream: true });
    if (this.mode === "probe") {
      this.probe += text;
      this.probeBytes += chunk.byteLength;
      if (isMuseModelPrefix(this.probe) && hasImageUrlObject(this.probe)) {
        // 只在确认 Muse 图片请求后进入修复路径；大图内容后续仍然流式处理。
        this.mode = "repair";
        this.buffer = this.probe;
        this.probe = "";
        this.repair(controller, false);
        return;
      }
      if (this.probeBytes >= PROBE_BYTES) {
        // 未命中已知问题时立刻恢复透明透传，避免长上下文被代理层持续扫描。
        this.mode = "pass";
        this.write(this.probe, controller);
        this.probe = "";
      }
      return;
    }

    this.buffer += text;
    this.repair(controller, false);
  }

  flush(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.mode === "pass") return;
    const rest = this.decoder.decode();
    if (this.mode === "probe") {
      this.write(this.probe + rest, controller);
      this.probe = "";
      return;
    }
    this.buffer += rest;
    this.repair(controller, true);
    if (this.buffer) {
      this.write(this.buffer, controller);
      this.buffer = "";
    }
  }

  private repair(controller: TransformStreamDefaultController<Uint8Array>, final: boolean): void {
    for (;;) {
      if (this.state === "normal" && !this.repairNormal(controller, final)) return;
      if (this.state === "url" && !this.repairUrl(controller)) return;
      if (this.state === "object-end" && !this.repairObjectEnd(controller)) return;
    }
  }

  private repairNormal(controller: TransformStreamDefaultController<Uint8Array>, final: boolean): boolean {
    const index = this.buffer.indexOf('"image_url"');
    if (index < 0) {
      if (final) {
        this.write(this.buffer, controller);
        this.buffer = "";
      } else if (this.buffer.length > 64) {
        // 保留少量尾巴，处理 token 刚好跨 chunk 的情况。
        this.write(this.buffer.slice(0, -64), controller);
        this.buffer = this.buffer.slice(-64);
      }
      return false;
    }

    if (index > 0) {
      this.write(this.buffer.slice(0, index), controller);
      this.buffer = this.buffer.slice(index);
    }

    const match = /^"image_url"\s*:\s*\{\s*"url"\s*:\s*/.exec(this.buffer);
    if (!match) {
      if (!final && this.buffer.length < 96) return false;
      this.write(this.buffer.slice(0, 1), controller);
      this.buffer = this.buffer.slice(1);
      return true;
    }

    // Muse 的网关错误地拒绝标准 OpenAI 形状：image_url: { url }。
    // 它接受 image_url: "data:..."；这里仅删除包裹对象，不触碰图片数据。
    this.write('"image_url":', controller);
    this.buffer = this.buffer.slice(match[0].length);
    this.state = "url";
    return true;
  }

  private repairUrl(controller: TransformStreamDefaultController<Uint8Array>): boolean {
    if (!this.urlStarted) {
      if (!this.buffer) return false;
      if (this.buffer[0] !== '"') {
        this.write(this.buffer.slice(0, 1), controller);
        this.buffer = this.buffer.slice(1);
        this.state = "normal";
        return true;
      }
      this.urlStarted = true;
    }

    const end = this.buffer.indexOf('"', this.buffer[0] === '"' ? 1 : 0);
    if (end < 0) {
      this.write(this.buffer, controller);
      this.buffer = "";
      return false;
    }
    this.write(this.buffer.slice(0, end + 1), controller);
    this.buffer = this.buffer.slice(end + 1);
    this.urlStarted = false;
    this.state = "object-end";
    return true;
  }

  private repairObjectEnd(controller: TransformStreamDefaultController<Uint8Array>): boolean {
    const trimmed = this.buffer.match(/^\s*/)?.[0] ?? "";
    if (trimmed.length === this.buffer.length) return false;
    if (this.buffer.charAt(trimmed.length) === "}") {
      this.buffer = this.buffer.slice(trimmed.length + 1);
    } else {
      // 非预期形状不再额外猜测，剩余内容按上游原样继续输出。
      this.write(this.buffer.slice(0, trimmed.length + 1), controller);
      this.buffer = this.buffer.slice(trimmed.length + 1);
    }
    this.state = "normal";
    return true;
  }

  private write(value: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (value) controller.enqueue(encoder.encode(value));
  }
}

export function repairRequestBody(request: Request): BodyInit | null {
  if (!shouldProbeRequest(request)) return request.body;
  return request.body!.pipeThrough(new TransformStream(new ImageUrlRepairTransformer()));
}

export { hasImageUrlObject, isMuseModelPrefix, shouldProbeRequest };
