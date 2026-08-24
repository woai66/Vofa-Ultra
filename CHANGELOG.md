# 更新日志

本文件记录面向用户的重要变化。项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。内部重构只有在改变行为、兼容性或发布风险时才记录。

## [Unreleased]

### Added

- 有界 RX 自动应答，支持有序 TEXT/HEX 字节规则、跨 chunk/重叠/NUL 匹配、安全命令模板响应和工作区 v4。
- FireWater / JustFloat 有界解析健康度，显示成功、丢弃、重同步、稳定原因和实时/回放独立统计。
- 协议解析、处理图和饱和数据平面的固定工作量性能预算、可审阅报告与独立 Linux CI 门禁。
- 工作区、本地状态、VUCAP 与协议 wire ID 的机器可读兼容矩阵、弃用政策和跨层防漂移门禁。
- 面向当前 UI 的用户手册、故障排查矩阵，以及只接受可复核真实设备证据的硬件报告流程。
- 三平台 canonical 构建环境记录，以及绑定实际 package job 与最终聚合资产的 GitHub provenance。
- 实验性 `.vux` Wasm 实时附加解析器，提供会话级 RX 授权、独立波形通道、确定性 pack/verify 工具、v1 JSON
  Schema 和由真实 Rust 运行时验证的最小示例。

### Changed

- 实时与回放通道按批写入环形缓冲，每个受影响通道只物化一次 2000 点快照，降低高吞吐主线程开销。
- 兼容性清单升级为 schema v2，以结构化记录实验性扩展标识、包格式、schema/API 版本和未来版本拒绝行为。

### Security

- 自动应答默认关闭且不响应回放；冷却、32 项 FIFO、单批 64 次匹配、会话 1,000 次及失败停机限制回显环路。
- 连接、来源、工作区、回放或运行环境变化时取消待发送命令，避免旧命令落入新的传输上下文。
- Wasm 扩展强制零 import/start、4 MiB memory、fuel/栈/队列/输入输出边界和会话代次隔离；guest 故障只停用
  扩展。扩展仍在主进程内解释执行，包未签名，SHA-256 不证明发布者身份。

## [0.1.0] - 2026-08-24

### Added

- Tauri 2 跨平台串口工作台，支持有界收发队列、文本/HEX、流控、DTR/RTS 和脱敏诊断。
- FireWater、JustFloat 与 Raw Data 增量数据链路，以及有界波形、处理 DAG、双游标和 3D 姿态视图。
- 工作区 v3、VUCAP v2 录制、v1/v2 回放与 seek、CSV/JSONL/二进制导出和实时数值 CSV。
- 命令历史、安全变量、可取消周期发送、强 USB 身份自动重连和跨端口名恢复。
- Vitest、Playwright、三平台 Rust 构建、无签名安装包、体积预算和统一版本门禁。
- 每目标 CycloneDX 1.6、完整许可证正文指纹、第三方 NOTICE、安装包内嵌资源和 SHA-256 清单。
- 三平台 artifact 二次复验、聚合发布清单，以及受保护环境中的 GitHub draft/prerelease 自动化。

### Security

- 主 WebView 使用最小 Tauri capability 与严格 CSP，不执行动态第三方代码。
- 串口输入、缓存、录制、回放、导出、处理图和诊断数据均有显式资源边界。
