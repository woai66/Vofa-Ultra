# Vofa-Ultra

面向 STM32、ESP32 等嵌入式开发者的现代化 Windows 串口与实时波形工作台。

[![Windows 10/11 x64](https://img.shields.io/badge/Windows-10%2F11_x64-0078D4)](docs/compatibility.md)
[![Beta preparing](https://img.shields.io/badge/v0.1.0--beta.1-preparing-F59E0B)](docs/roadmap.md)
[![MIT License](https://img.shields.io/badge/license-MIT-22C55E)](LICENSE)

连接设备、核对原始字节、发送命令，并把 FireWater 或 JustFloat 数据实时变成波形。Vofa-Ultra 目前优先把
Windows 上最常用的串口链路做可靠，再逐步扩展高级能力。

> **当前状态：** `v0.1.0-beta.1` 正在准备中，尚未公开发布。候选安装包未经代码签名，也尚未完成真实硬件验收，
> 请不要把当前代码或本地构建当作稳定版本。

![Vofa-Ultra 实时串口与波形工作台](docs/images/workbench.png)

## 下载

首个公开测试版将发布在 [GitHub Releases](https://github.com/woai66/Vofa-Ultra/releases)，只提供一个适用于
Windows 10/11 x64 的未签名 NSIS `.exe` 安装包。

发布前会在 Release 正文中提供 SHA-256、测试环境和已知限制。Windows 可能对未签名程序显示 SmartScreen 提示；
请只使用本仓库发布的文件并核对摘要，不要关闭系统全局安全策略。

## 核心体验

| 串口底座 | 实时波形 | 清晰诊断 |
| --- | --- | --- |
| 可靠枚举、连接、断开与拔插恢复 | FireWater / JustFloat 最多 16 通道 | 明确状态、错误原因与脱敏诊断 |
| TEXT / HEX、行尾与多种文本编码 | 暂停、缩放、量程、测量和回到实时 | 终端搜索、筛选、统计与导出 |

主要能力：

- 配置波特率、数据位、校验位、停止位和流控，在线控制 DTR / RTS，并监视 CTS / DSR / RI / DCD。
- 使用 TEXT 或 HEX 双向收发，支持 LF / CR / CRLF，以及 UTF-8、GB18030、Windows-1252 文本编码。
- 在有界终端中查看 RX / TX、搜索和筛选记录、切换时间基准，并导出全部缓存或当前视图。
- 解析 FireWater 文本帧和 JustFloat 二进制帧，显示实时波形、通道数值与解析健康度。
- 录制原始会话和数值数据，完成基础回放与导出；工作区可保存常用设备和显示配置。
- 使用可复现模拟器先体验界面、协议和波形，无需连接真实设备。

## 五分钟上手

1. 从 GitHub Releases 获取候选安装包，核对版本和 SHA-256 后完成安装。
2. 连接开发板或 USB 转串口设备，打开“连接”，选择“串口”和目标端口。
3. 按固件配置波特率、数据位、校验位、停止位和流控。
4. 选择协议：文本数值使用 FireWater，浮点二进制使用 JustFloat，任意原始字节使用 Raw Data。
5. 点击“连接设备”，先在终端核对 RX；需要波形时，再确认协议帧数和通道曲线。
6. 在底部发送栏输入 TEXT 或 HEX 命令；测试结束后导出日志，或从“记录”保存会话。

第一次体验也可以选择“模拟器”，使用 FireWater 和默认正弦信号直接启动。浏览器开发预览只能使用模拟器，
不能访问本机串口。

## 数据协议

| 协议 | 输入 | 波形 |
| --- | --- | --- |
| FireWater | 每行 1–16 个数值，可使用 `label:value` 或 `label=value` | 支持 |
| JustFloat | 1–16 个小端 `float32`，以 `00 00 80 7F` 结束 | 支持 |
| Raw Data | 任意原始字节 | 不生成通道，仅进入终端 |

FireWater 示例：

```text
1.25,-2,3
temperature:23.5,voltage:3.30
```

Raw Data 不猜测数据类型、大小端、通道或帧结构。可配置二进制帧解码器会作为后续独立协议设计，而不是改变
Raw 的原始语义。完整格式和解析边界见[协议文档](docs/protocols.md)。

## 首个 Beta 范围

| 状态 | 范围 |
| --- | --- |
| 重点验收 | Windows x64 串口生命周期、TEXT / HEX、编码与行尾、终端、FireWater / JustFloat 波形、基础记录 |
| 保留但冻结 | Modbus RTU、处理图、3D 姿态、频谱、Wasm 扩展和复杂自动化 |
| 后续延期 | macOS / Linux、Windows ARM64、MSI、签名、更新器、复杂 Actions 和可配置二进制解码器 |

冻结功能仍保留在应用中，可以修复阻塞性缺陷，但不继续扩展，也不作为首个 Beta 的发布门槛。完整清单和后续方向
见[路线图](docs/roadmap.md)。

## 当前限制

- 只支持 Windows 10/11 x64；首个 Beta 不提供 macOS、Linux、ARM64 或 MSI 安装包。
- 安装包尚未签名，项目也没有自动更新器。
- Raw Data 只保证原始字节终端路径，不自动生成波形。
- 真实设备兼容性清单仍为空；自动测试和模拟器不能代替 USB 驱动、线缆、开发板与长时间采集测试。
- 项目暂不启用 GitHub Actions，测试、构建和候选包整理由维护者在本地执行。

## 真实硬件测试

首个 Beta 必须经过 Windows 安装、启动、卸载，以及真实设备连接、双向收发、波形、拔插重连和持续运行验证。

- [首轮 Beta 快速测试](docs/hardware-compatibility.md#首轮-beta-快速测试)
- [硬件兼容性清单与报告要求](docs/hardware-compatibility.md)
- [硬件测试报告](https://github.com/woai66/Vofa-Ultra/issues/new?template=hardware_report.yml)

测试失败同样有价值。提交报告前请移除完整 USB 序列号、端口名、用户名、业务载荷和其他敏感信息。

## 本地开发

需要 Node.js 22、pnpm 11、Rust 1.88.0 或更高版本，以及
[Tauri 2 的 Windows 依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

浏览器开发预览地址为 <http://127.0.0.1:1420>。需要真实串口时运行桌面开发模式：

```bash
pnpm tauri dev
```

提交前至少运行：

```bash
pnpm check
pnpm test:e2e
```

Rust 检查、Windows NSIS 构建和人工发布步骤见[发布流程](docs/release-process.md)。仓库已提交锁文件，发布构建应使用
锁定依赖。

## 文档

| 文档 | 内容 |
| --- | --- |
| [用户手册](docs/user-guide.md) | 连接、收发、波形、记录、回放与工作区 |
| [故障排查](docs/troubleshooting.md) | 按症状定位连接、协议、文件和性能问题 |
| [路线图](docs/roadmap.md) | Beta 范围、冻结能力与发布门槛 |
| [兼容性政策](docs/compatibility.md) | Windows 支持矩阵、格式版本与弃用规则 |
| [架构说明](docs/architecture.md) | 数据链路、资源边界、生命周期和故障语义 |
| [协议文档](docs/protocols.md) | FireWater、JustFloat、Raw 与解析器契约 |
| [发布流程](docs/release-process.md) | 本地检查、NSIS 候选包和预发布步骤 |
| [供应链说明](docs/supply-chain.md) | SBOM、许可证材料和产物校验边界 |

## 项目方向

Vofa-Ultra 学习 [VOFA+](https://www.vofa.plus/) 与
[vofa-NEXT](https://github.com/Horldsence/vofa-NEXT) 的产品经验，但采用独立实现。项目不会用功能数量衡量进度，
而是优先改善连接可靠性、波形流畅度、操作清晰度、问题诊断和长期可维护性。详细调研见
[竞品分析](docs/competitive-analysis.md)。

## 参与贡献

提交代码前请阅读[贡献指南](CONTRIBUTING.md)。使用问题可查看[支持政策](SUPPORT.md)，可复现缺陷和功能讨论请提交
[Issue](https://github.com/woai66/Vofa-Ultra/issues)。安全问题请按[安全策略](SECURITY.md)私下报告。

## 许可证

Vofa-Ultra 使用 [MIT License](LICENSE)。第三方依赖仍受各自许可证约束。
