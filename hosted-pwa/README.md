# VoiceBridge Hosted PWA

静态官网和手机网页，部署目标为 Cloudflare Pages；`worker/static.js` 同时保留静态 Worker 的路由映射。当前发布不使用旧 vinext/Next.js starter。

```bash
# 从仓库根目录运行
npm --prefix hosted-pwa run build
npm --prefix hosted-pwa test
./scripts/verify
```

构建生成 `dist/client` 静态资源和 `dist/server/index.js`。`build-landing.mjs` 根据 `landing/template.html` 与 `landing/locales/{en,zh-CN}.json` 生成官网，`build-static.mjs` 校验共用镜像、打包本地 Supabase SDK 并移除测试资源。

- 官网 `/`、`/zh-CN/`；手机应用 `/app`；法律/FAQ 页面独立发布。
- 共用逻辑源为 `../src/public`，对应镜像在 `public`，共享协议在 `public/shared`。构建不允许漏文件或内容漂移。
- `public/config.js` 只含公开 URL、publishable key 与 Paddle client token；密钥只在云端。
- 用户在手机登录并扫码认领电脑，桌面无需输入账号密码。
- 移动端通过根目录 `npm run mobile:prepare` 从当前构建生成本地网页包。

发布命令 `bash scripts/deploy.sh frontend` 必须在明确授权后执行，Live Paddle 仍保留既有发布门。完整架构、验收边界及远端顺序见根 README。
