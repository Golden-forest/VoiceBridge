# VoiceBridge Mobile

Capacitor 容器同时支持 iOS 与 Android。页面、Supabase SDK 和录音逻辑随安装包发布，启动时不依赖第三方前端 CDN。

```bash
npm run mobile:prepare
npm --prefix mobile run sync
npm --prefix mobile run open:ios
# 或 npm --prefix mobile run open:android
```

云端会持久化登录并自动恢复最近使用的桌面设备。局域网直连的产品权限不变：只有 `pro` 和 `admin` 账号的桌面端才会启动并公布 LAN 服务，`free` 账号不能使用 LAN。

当前目录用于自用侧载和真机测试。提交 App Store / Google Play 前，需要补齐原生商店支付和正式签名配置。
