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
- 只接受 `chat/completions`、`messages` 和 `responses` 三类 API 路径

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
- 让 Responses 客户端在上游响应 ID 失效时自动回退到完整历史重试

符合标准的健康 SSE 流会保持原文。只有 Chat Completions 的 2xx SSE
响应会进入流式修复；Messages、Responses 和无关响应直接透传。

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

### 本地构建部署文件

先在项目根目录生成单文件 Worker：

```bash
npm ci
npm test
npm run check
npm run build
```

可部署脚本会生成在 `dist/worker.js`。`dist/worker.js.map` 只用于调试，不上传也不
影响运行；每次修改源码后都需要重新执行 `npm run build`。

在 Cloudflare Dashboard 创建一个 Worker，用 `dist/worker.js` 替换默认的
`worker.js` 并部署即可；不需要配置环境变量或绑定。

本地调试：

```bash
npm run dev
```
