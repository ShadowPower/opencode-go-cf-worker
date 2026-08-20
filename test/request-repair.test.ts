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
    const output = await repairJSON(input, 3);

    expect(output).toContain('"image_url":"data:image/jpeg;base64,AA=="');
    expect(output).not.toContain('"image_url":{"url"');
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

  it("非 Muse 请求保持原样", async () => {
    const input = JSON.stringify({
      model: "mimo-v2.5",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }],
      stream: true,
    });

    await expect(repairJSON(input, 5)).resolves.toBe(input);
  });

  it("未命中探测窗口后恢复透明透传", async () => {
    const prefix = "x".repeat(260 * 1024);
    const input = JSON.stringify({
      messages: [{ role: "user", content: prefix }],
      model: "muse-spark-1.2-contributor",
      stream: true,
    });

    await expect(repairJSON(input, 4096)).resolves.toBe(input);
  });
});
