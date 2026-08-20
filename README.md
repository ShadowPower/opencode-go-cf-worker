# OpenCode Cloudflare Worker

一个面向 `opencode.ai` 的轻量透明反向代理。部署后只需把原 URL 中的域名替换成
Worker 域名，路径、查询参数、请求体和 API Key 都不需要修改。

```text
https://opencode.ai/zen/go/v1/chat/completions
                         ↓ 只替换域名
https://opencode-go-worker.<你的子域>.workers.dev/zen/go/v1/chat/completions
```

## 特点

- 固定代理到 `https://opencode.ai`，没有多余的上游、鉴权或路由配置
- 使用原生 `fetch` 和 `TransformStream`，不缓存完整请求或响应
- 每个请求独立维护少量 SSE 状态，没有锁和全局可变状态
- 健康帧保持原文，只有实际发生修复的帧才重新序列化
- 显式限制为 10 ms CPU，适用于 Cloudflare Workers 免费版
- 删除传给上游的 Cloudflare 客户端 IP 等隐私头
- 上游重定向会自动改写成当前 Worker 域名

## 修复的上游流式问题

处理 OpenCode issue #40420、#42918、#43379 涉及的异常 SSE：

- 补全缺失的 `finish_reason` 和 `data: [DONE]`
- 根据内容选择 `stop`、`tool_calls` 或 `function_call`
- 为首个 choice 补 `role: assistant`
- 补齐后续帧缺失的 `id`、`model`、`created`、`system_fingerprint`
- 删除非标准 `cost` 尾帧和 usage 中的 `cost` 字段
- 确保终止 choice 在 usage 之前输出
- 丢弃没有 choice、也没有 usage 的空帧
- 未知模型没有可靠完成证据时，不把意外断流伪装为成功
- 兼容 Muse Spark 1.2 对标准 OpenAI 图片请求格式的错误拒绝

符合标准的健康 SSE 流会保持原文。只有 2xx 且 `Content-Type` 为
`text/event-stream` 的响应会进入修复流，JSON 等其他响应直接透传。

## 部署

要求 Node.js 20 或更高版本。

### 推荐：Wrangler 部署 Worker

```bash
npm install
npm test
npm run check
npx wrangler login
npm run deploy
```

部署输出会给出 `workers.dev` 地址。若要使用自己的域名，可在 Cloudflare Dashboard
的 Worker 页面添加 Custom Domain；代码不需要变化。

本地调试：

```bash
npm run dev
```
