// Cloudflare Workers Dashboard 的 Hello World 默认入口通常叫 `worker.js`。
// 这里只做入口转发，核心代理逻辑放在 index.ts，便于测试和复用。
export { default } from "./index";
