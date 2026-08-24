# 更新日志

本文件记录面向用户的重要变化。项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。内部重构只有在改变行为、兼容性或发布风险时才记录。

## [Unreleased]

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
