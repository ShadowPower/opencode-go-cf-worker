import { describe, expect, it } from "vitest";
import { repairSSE } from "../src/sse-repair";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sse(data: string): string {
  return `data: ${data}\n\n`;
}

async function repair(input: string, chunkSize = input.length): Promise<string> {
  let offset = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= input.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(input.slice(offset, offset + chunkSize)));
      offset += chunkSize;
    },
  });
  return decoder.decode(await new Response(repairSSE(source)).arrayBuffer());
}

describe("SSE 修复", () => {
  it("不改动健康的标准流", async () => {
    const input =
      sse('{"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"muse-spark-1.2","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}') +
      sse('{"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"muse-spark-1.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}') +
      sse("[DONE]");
    await expect(repair(input, 7)).resolves.toBe(input);
  });

  it("修复异常 cost 尾帧并调整 usage 顺序", async () => {
    const input =
      sse('{"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"muse-spark-1.2-contributor","choices":[]}') +
      sse('{"id":"","object":"chat.completion.chunk","created":1,"model":"","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}') +
      sse('{"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"muse-spark-1.2-contributor","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}') +
      sse('{"choices":[],"cost":"0"}');
    const output = await repair(input, 1);

    expect(output).toContain('"role":"assistant"');
    expect(output).toContain('"id":"gen-1"');
    expect(output).toContain('"model":"muse-spark-1.2-contributor"');
    expect(output).toContain('"finish_reason":"stop"');
    expect(output).toContain("data: [DONE]");
    expect(output).not.toContain('"cost":"0"');
    expect(output.indexOf('"finish_reason":"stop"')).toBeLessThan(output.indexOf('"usage"'));
  });

  it("为工具调用补正确的结束原因", async () => {
    const input =
      sse('{"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"muse-spark-1.2","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"search","arguments":"{}"}}]},"finish_reason":null}]}') +
      sse('{"choices":[],"cost":"0"}');
    expect(await repair(input)).toContain('"finish_reason":"tool_calls"');
  });

  it("不把未知模型的断流伪装成成功", async () => {
    const input = sse('{"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"unknown-model","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}');
    await expect(repair(input, 3)).resolves.toBe(input);
  });

  it("支持多 choice，并按 index 生成终止帧", async () => {
    const input =
      sse('{"id":"gen-1","object":"chat.completion.chunk","model":"muse","choices":[{"index":2,"delta":{"content":"B"},"finish_reason":null},{"index":0,"delta":{"content":"A"},"finish_reason":null}]}') +
      sse('{"choices":[],"cost":"0"}');
    const output = await repair(input);
    const terminal = output.slice(output.lastIndexOf('data: {', output.indexOf("data: [DONE]")));
    expect(terminal.indexOf('"index":0')).toBeLessThan(terminal.indexOf('"index":2'));
  });

  it("流错误时不伪造成功尾帧", async () => {
    const input = sse('{"id":"gen-1","object":"chat.completion.chunk","model":"muse","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}');
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(input));
        controller.error(new Error("upstream disconnected"));
      },
    });
    await expect(new Response(repairSSE(source)).text()).rejects.toThrow("upstream disconnected");
  });

  it("大量健康内容帧仍保持原文", async () => {
    const frames = Array.from({ length: 1_000 }, (_, index) =>
      sse(`{"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"muse-spark-1.2","choices":[{"index":0,"delta":{"${index === 0 ? 'role":"assistant","' : ""}content":"${index}"},"finish_reason":null}]}`),
    );
    const input =
      frames.join("") +
      sse('{"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"muse-spark-1.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}') +
      sse("[DONE]");
    await expect(repair(input)).resolves.toBe(input);
  });

  it("不依赖上游 JSON 的空格和字段顺序", async () => {
    const input =
      sse('{ "choices": [ { "finish_reason": null, "delta": { "content": "OK" }, "index": 0 } ], "model": "muse", "object": "chat.completion.chunk", "id": "spaced" }') +
      sse('{ "cost": "0", "choices": [] }');
    const output = await repair(input);
    expect(output).toContain('"role":"assistant"');
    expect(output).toContain('"id":"spaced"');
    expect(output).toContain('"finish_reason":"stop"');
    expect(output).toContain("data: [DONE]");
  });

  it("并发请求之间不会共享修复状态", async () => {
    const outputs = await Promise.all(
      Array.from({ length: 50 }, (_, index) => {
        const input =
          sse(`{"id":"request-${index}","object":"chat.completion.chunk","model":"muse","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}`) +
          sse('{"choices":[],"cost":"0"}');
        return repair(input, 5);
      }),
    );
    for (let index = 0; index < outputs.length; index++) {
      expect(outputs[index]).toContain(`"id":"request-${index}"`);
      expect(outputs[index]).toContain("data: [DONE]");
    }
  });
});
