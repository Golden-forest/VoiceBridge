# VoiceBridge ASR 复用优化进度

更新日期：2026-08-16

## 已完成

- 审计现有录音、腾讯 ASR、云函数、Realtime、桌面 Agent、文本注入和测试结构。
- 联网调研 Type4Me、Koe、FunASR、sherpa-onnx、vad-web、WhisperLiveKit、Speaches、funasr-server 和 WeTextProcessing。
- 确定“保留 VoiceBridge 商用底座，只复用缺失层”的方向。
- 创建 [research.md](./research.md) 和 [plan.md](./plan.md)。
- 运行 `npm test`：193 项通过，0 失败。

## 当前状态

- 仅规划完成，尚未修改生产业务代码。
- 尚未安装第三方依赖、下载模型、启动容器或调用新的外部服务。
- 下一步门禁是 WP-0 商用合规清单与 WP-1 评测工具/语料设计。

## 待执行

- [ ] WP-0 第三方商用合规清单。
- [ ] WP-1 基准语料与可重复评测工具。
- [ ] WP-2 腾讯基线拆分与低成本优化。
- [ ] WP-3 浏览器录音/VAD 复用试验。
- [ ] WP-4 ASR Provider 薄接口。
- [ ] WP-5 FunASR 官方服务试验。
- [ ] WP-6 结果聚合、词典与后处理模式。
- [ ] WP-7 灰度、可观测性和商用发布。
- [ ] WP-8 可选本地 sherpa-onnx 模式。

## 已知风险

- FunASR/sherpa-onnx 的框架许可证不能替代具体模型权重许可审查。
- 真实中文短句质量尚无本项目自有语料证据，现阶段不得宣称任一候选优于腾讯。
- 浏览器 VAD 可能改善自动端点，却也可能误丢极短语音；必须与现有按住说话录音器实测。
- 新增自托管 ASR 会带来鉴权、容量、成本、地区和隐私责任。
- LLM 清理可能改义，不得成为无原文、不可关闭的强制步骤。

