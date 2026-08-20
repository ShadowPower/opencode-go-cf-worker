import { describe, expect, it } from "vitest";
import { repairRequestBody } from "../src/request-repair";

const encoder = new TextEncoder();

async function repairJSON(body: string, chunkSize = body.length): Promise<string> {
  let offset = 0;
  const request = new Request("https://demo.example.workers.dev/zen/go/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(body.slice(offset, offset + chunkSize)));
        offset += chunkSize;
      },
    }),
    duplex: "half",
  } as RequestInit);
  const repaired = repairRequestBody(request);
  return await new Response(repaired).text();
}

async function repairChunks(chunks: string[]): Promise<string> {
  let index = 0;
  const request = new Request("https://demo.example.workers.dev/zen/go/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[index++]));
      },
    }),
    duplex: "half",
  } as RequestInit);
  return await new Response(repairRequestBody(request)).text();
}

async function repairByteChunks(chunks: Uint8Array[]): Promise<Uint8Array> {
  let index = 0;
  const request = new Request("https://demo.example.workers.dev/zen/go/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]);
      },
    }),
    duplex: "half",
  } as RequestInit);
  return new Uint8Array(await new Response(repairRequestBody(request)).arrayBuffer());
}

describe("请求体兼容修正", () => {
  it("把 Muse 图片请求里的 image_url.url 流式折叠为字符串", async () => {
    const input = JSON.stringify({
      model: "muse-spark-1.2-contributor",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "描述图片" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA==" } },
          ],
        },
      ],
      stream: true,
    });
    const output = await repairJSON(input, 1);

    expect(output).toContain('"image_url":"data:image/jpeg;base64,AA=="');
    expect(output).not.toContain('"image_url":{"url"');
  });

  it("支持标准 image_url 对象的 detail 字段及不同字段顺序", async () => {
    const input = JSON.stringify({
      model: "muse-spark-1.2-contributor",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } },
            { type: "image_url", image_url: { detail: "low", url: "data:image/png;base64,BB==" } },
          ],
        },
      ],
    });
    const output = await repairJSON(input, 7);

    expect(JSON.parse(output).messages[0].content).toEqual([
      { type: "image_url", image_url: "data:image/png;base64,AA==" },
      { type: "image_url", image_url: "data:image/png;base64,BB==" },
    ]);
  });

  it("大图片数据不需要整体 JSON 解析或缓冲", async () => {
    const image = "A".repeat(512 * 1024);
    const input =
      '{"model":"muse-spark-1.2-contributor","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,' +
      image +
      '"}}]}],"stream":true}';
    const output = await repairJSON(input, 8192);

    expect(output).toContain('"image_url":"data:image/jpeg;base64,');
    expect(output).toContain(image);
    expect(output).not.toContain('"image_url":{"url"');
  });

  it("支持图片字符串结束引号正好落在新 chunk 开头", async () => {
    const first =
      '{"model":"muse-spark-1.2-contributor","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,AAAA';
    const output = await repairChunks([first, '"}}]}],"stream":true}']);

    expect(output).toBe(
      '{"model":"muse-spark-1.2-contributor","messages":[{"role":"user","content":[{"type":"image_url","image_url":"data:image/jpeg;base64,AAAA"}]}],"stream":true}',
    );
  });

  it("正确处理 URL 字符串中的转义字符", async () => {
    const input = JSON.stringify({
      model: "muse-spark-1.2-contributor",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: 'https://example.test/a\\"b', detail: "auto" } }],
        },
      ],
    });
    const output = await repairJSON(input, 2);

    expect(JSON.parse(output).messages[0].content[0]).toEqual({
      type: "image_url",
      image_url: 'https://example.test/a\\"b',
    });
  });

  it("非 Muse 请求保持原样", async () => {
    const input = JSON.stringify({
      model: "mimo-v2.5",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }],
      stream: true,
    });

    await expect(repairJSON(input, 5)).resolves.toBe(input);
  });

  it("只识别顶层 model，不受 metadata 中同名字段影响", async () => {
    const input = JSON.stringify({
      model: "mimo-v2.5",
      metadata: { model: "muse-shadow" },
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }],
    });

    await expect(repairJSON(input, 11)).resolves.toBe(input);
  });

  it("Muse 请求中非消息内容路径的 image_url 保持原样", async () => {
    const input = JSON.stringify({
      model: "muse-spark-1.2-contributor",
      metadata: { image_url: { url: "https://example.test/metadata.png" } },
      messages: [{ role: "user", content: "普通文本" }],
    });

    await expect(repairJSON(input, 3)).resolves.toBe(input);
  });

  it("model 位于消息之后时不冒险改写已经透传的数据", async () => {
    const input = JSON.stringify({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }],
      model: "muse-spark-1.2-contributor",
    });

    await expect(repairJSON(input, 4)).resolves.toBe(input);
  });

  it("已经兼容的字符串 image_url 保持原样", async () => {
    const input = JSON.stringify({
      model: "muse-spark-1.2-contributor",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: "data:image/png;base64,AA==" }] }],
    });

    await expect(repairJSON(input, 1)).resolves.toBe(input);
  });

  it("无法安全折叠的 image_url 对象保持原样且不影响后续图片", async () => {
    const input = JSON.stringify({
      model: "muse-spark-1.2-contributor",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: { unsupported: true } } },
            { type: "image_url", image_url: { alt: "缺少 URL" } },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          ],
        },
      ],
    });
    const output = JSON.parse(await repairJSON(input, 5));

    expect(output.messages[0].content).toEqual([
      { type: "image_url", image_url: { url: { unsupported: true } } },
      { type: "image_url", image_url: { alt: "缺少 URL" } },
      { type: "image_url", image_url: "data:image/png;base64,AA==" },
    ]);
  });

  it("长上下文之后的 Muse 图片仍会修正", async () => {
    const prefix = "上下文".repeat(100 * 1024);
    const input = JSON.stringify({
      model: "muse-spark-1.2-contributor",
      messages: [
        { role: "user", content: prefix },
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
      ],
    });
    const output = await repairJSON(input, 16 * 1024);

    expect(JSON.parse(output).messages[1].content[0].image_url).toBe("data:image/png;base64,AA==");
  });

  it("非 Muse 长请求在任意 UTF-8 分块边界都逐字节保持不变", async () => {
    const header = encoder.encode('{"model":"mimo-v2.5","messages":[{"role":"user","content":"');
    const chinese = encoder.encode("中");
    const suffix = encoder.encode('"}]}');
    const fill = encoder.encode("x".repeat(256 * 1024 - header.byteLength - 1));
    const first = new Uint8Array(header.byteLength + fill.byteLength + 2);
    first.set(header);
    first.set(fill, header.byteLength);
    first.set(chinese.subarray(0, 2), header.byteLength + fill.byteLength);
    const second = new Uint8Array(1 + suffix.byteLength);
    second.set(chinese.subarray(2));
    second.set(suffix, 1);
    const expected = new Uint8Array(first.byteLength + second.byteLength);
    expected.set(first);
    expected.set(second, first.byteLength);

    await expect(repairByteChunks([first, second])).resolves.toEqual(expected);
  });
});
