# VoiceBridge ASR 复用优化调研

更新日期：2026-08-16

## 目标

为商用 VoiceBridge 选择可复用的录音、ASR、文本后处理组件。默认保留现有实现；只有外部方案在准确率、延迟、稳定性、维护成本或商业合规方面有可验证的净收益时，才引入、迁移或局部借鉴。

## 当前基线

现有实现不是需要整体替换的原型，以下能力已经较完整，应作为不可回退的基线：

- 手机 PWA 录音、16 kHz 单声道 WAV 编码和非 16 kHz 输入重采样。
- 腾讯 FlashRecognition 优先、SentenceRecognition 回退、总超时预算和错误处理。
- Supabase 登录、设备配对、私有 Realtime 通道、指令 ACK、套餐与用量预留。
- Electron/CLI 桌面代理、目标窗口选择、剪贴板、自动粘贴和按键命令。
- LAN 与 cloud 两套路径及用户可编辑文本框。
- 193 项 Node 测试；2026-08-16 执行 `npm test` 全部通过。

当前主要差距：

- 浏览器录音仍基于 `ScriptProcessorNode`，没有模型级 VAD、首尾 padding 和短句边界质量指标。
- 腾讯已设置部分语气词过滤，应用层又用正则二次过滤；无法区分“犹豫词”和有语义的“嗯/啊/哦”。
- ASR Provider 在云端和 LAN 端均与腾讯实现耦合，尚无统一 Provider 契约。
- 没有保存 raw transcript、provider transcript、postprocessed transcript，无法审计是哪一层改坏文本。
- 未使用腾讯热词、词级时间戳等现成功能，也没有用户词典。
- 没有短句/语气词/专有名词/数字格式的可重复对比语料与指标。
- 云端最终文本直接发送，尚无 Interim/Definite/Final 聚合模型和“忠实/清爽”后处理模式。

## 外部项目结论

| 项目 | 可商用前提 | 对 VoiceBridge 的实际价值 | 决策 |
| --- | --- | --- | --- |
| [Type4Me](https://github.com/joewongjc/type4me) | MIT；仍须核对其模型和第三方 SDK | Provider 抽象、录音→ASR→后处理→注入状态机、热词与映射词分层、快速/润色模式 | 借鉴架构和小型通用模块；不迁移 Swift/macOS 产品壳 |
| [Koe](https://github.com/missuo/koe) | MIT；仍须核对云服务和模型条款 | Interim/Definite/Final 聚合、interim history、词典同时供 ASR 与 LLM、Provider/模型管理 | 借鉴聚合契约、词典和提示词；不迁移 Rust/Objective-C 产品壳 |
| [FunASR](https://github.com/modelscope/FunASR) Runtime | 框架 MIT；每个模型权重单独核对 | 官方两遍 WebSocket/服务部署，集成 VAD、Paraformer、标点、ITN、热词 | 中文替代 ASR 的首选试验；优先原样部署官方服务并写薄适配器 |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0；模型权重单独核对 | Node addon 示例覆盖 VAD、Paraformer、SenseVoice、ITN、标点和同音词替换 | 本地 Electron ASR 首选；在云端质量路线确定后再做 |
| [vad-web](https://github.com/ricky0123/vad) | 引入前核对仓库、npm 包、Silero 与 ONNX Runtime 的全部许可证 | 浏览器 AudioWorklet、16 kHz 输出、Silero VAD、speech start/end、padding | 录音层首选试验；作为依赖使用，不复制维护其实现 |
| [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit) | Apache-2.0；后端模型单独核对 | OpenAI REST、Deepgram/原生 WS、VAD、LocalAgreement、FunASR/SenseVoice 后端 | 作为统一 A/B 网关和流式算法参考；第一阶段不作为生产核心 |
| [Speaches](https://github.com/speaches-ai/speaches) | MIT；Whisper 模型和依赖单独核对 | Docker、OpenAI 兼容 API、Faster-Whisper 和 VAD | 仅作 Whisper 基线，不作为中文首选 |
| [funasr-server](https://github.com/WEIFENG2333/funasr-server) | MIT；模型单独核对 | 自动安装与 JSON-RPC 封装 | 可参考安装器；项目规模小且非流式，不作生产依赖 |
| [WeTextProcessing](https://github.com/wenet-e2e/WeTextProcessing) | Apache-2.0 | 中文数字、日期、金额等 ITN | 仅在 ASR 自带 ITN 不满足评测时引入 |

## 商用边界

- “源码 MIT/Apache-2.0”不等于“模型权重、训练数据、SDK、Docker 镜像全部同许可证”。每个制品必须单独记录来源、版本、哈希、许可证和再分发条件。
- 优先以依赖、官方服务或官方容器方式复用；复制源码仅用于上游不提供稳定依赖入口且移植收益明确的部分。
- 不引入 GPL/AGPL 或来源不清代码到商用客户端/服务，除非完成专门法律评估并明确接受其义务。
- 复制 MIT/Apache-2.0 代码时保留版权、许可证和 NOTICE；建立第三方清单。
- 新增云 ASR/LLM 服务属于新的数据处理方，发布前必须同步隐私政策、数据地域、保留策略和用户告知。
- 生产环境不得记录原始用户音频或完整转写；评测语料必须取得授权并与生产数据隔离。

## 关键事实来源

- FunASR 官方 Runtime 已提供两遍识别、流式结果、离线纠错、标点、热词和 Docker/WebSocket 部署：[Runtime quick start](https://github.com/modelscope/FunASR/blob/main/runtime/quick_start.md)。
- FunASR WebSocket 客户端已定义 `mode`、`chunk_size`、`hotwords`、`itn`、`is_speaking` 等协议字段：[official client](https://github.com/modelscope/FunASR/blob/main/runtime/python/websocket/funasr_wss_client.py)。
- sherpa-onnx Node addon 已有 VAD + SenseVoice/Paraformer 麦克风、流式 Paraformer、ITN、标点和同音词替换示例：[Node addon examples](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md)。
- vad-web 在浏览器中通过 ONNX Runtime Web 运行 Silero VAD，并向回调提供 16 kHz `Float32Array`：[browser guide](https://docs.vad.ricky0123.com/user-guide/browser/)。
- Koe 明确实现 Provider、TranscriptAggregator、interim history、词典和 LLM 纠错链路：[Koe](https://github.com/missuo/koe)。
- Type4Me 明确实现可插拔 ASR、热词、映射词和快速/润色模式：[Type4Me](https://github.com/joewongjc/type4me)。

