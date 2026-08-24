# 实验性 Wasm 协议扩展 v1

Vofa-Ultra 桌面端提供实验性的 `vux-wasm-v1` 协议解析扩展。它让用户选择本地 `.vux` 包，在一次实时连接
会话中把原始 RX 字节的副本交给受限 Wasm 解释器，并把扩展输出显示为独立波形通道。它不替代内置 parser，
也不是稳定插件生态：`compatibility-policy.json` 将其标记为 `vux-wasm-v1-experimental`，预发布版本可在安全修复
或实测反馈后修改 ABI。

浏览器预览不加载扩展。当前只支持 `protocol-parser`，不支持 JavaScript、原生动态库、WASI、网络、文件系统、
Shell、UI 注入、处理图节点或回放 parser。

## `.vux` 包

`.vux` 是 UTF-8 JSON 文件，不是 ZIP。v1 的机器可读约束见
[`schemas/extension-v1.schema.json`](../schemas/extension-v1.schema.json)：

```json
{
  "format": "vofa-ultra-extension",
  "schemaVersion": 1,
  "manifest": {
    "id": "io.example.device-parser",
    "version": "1.0.0",
    "name": "Device parser",
    "description": "Parses the device telemetry stream",
    "license": "MIT",
    "apiVersion": 1,
    "kind": "protocol-parser",
    "capabilities": ["live-rx.read"]
  },
  "moduleSha256": "<64 lowercase hex characters>",
  "moduleBase64": "<canonical RFC 4648 Base64>"
}
```

根对象和 manifest 都拒绝未知字段。主要边界如下：

| 项目 | v1 上限或规则 |
| --- | --- |
| `.vux` 文件 | 普通文件、`.vux` 后缀、最多 1.5 MiB |
| Wasm 模块 | 非空、最多 1 MiB、SHA-256 必须匹配 |
| `id` | 3-128 ASCII 字节，至少两个小写反向域名段；段内可含数字和非首尾连字符 |
| `version` | 1-128 ASCII 字节、SemVer，major/minor/patch 均适配 `u64` |
| `name` | 1-64 字符、最多 256 UTF-8 字节 |
| `description` | 0-256 字符、最多 1024 UTF-8 字节 |
| `license` | 作者声明的 1-128 ASCII 字节文本，不得有首尾空白 |
| `apiVersion` / `kind` | 固定为 `1` / `protocol-parser` |
| `capabilities` | 必须且只能是 `live-rx.read` |

名称、描述和输出标签拒绝控制字符、非普通空白、双向覆盖符及不可见格式字符。`license` 是扩展作者的声明；
宿主不验证它是否为完整或有效的 SPDX 表达式，也不随包携带许可证正文或 NOTICE。

运行时拒绝未知 schema 和 API 版本，不猜测未来字段。仓库 packer 会输出固定字段顺序、两个空格缩进、LF 和
末尾换行；verifier 还会拒绝不符合该 canonical 表示的包。宿主加载器只要求严格、无重复字段的合法 v1 JSON，
canonical 表示是发布工具契约，不是发布者身份认证。

## Wasm ABI

模块不得声明任何 import 或 start 函数，必须导出一个名为 `memory` 的 32 位线性内存和以下函数：

```text
vofa_abi_version() -> i32
vofa_input_ptr() -> i32
vofa_reset() -> i32
vofa_push(input_length: i32, received_at_ms: f64) -> i64
```

- `vofa_abi_version` 必须返回 `1`。
- `vofa_input_ptr` 返回宿主写入 RX 批次的固定非负偏移。从该偏移开始必须至少容纳 64 KiB。
- `vofa_reset` 清除 guest 的流式解析状态，成功返回 `0`；非零值是 ABI 故障。
- 宿主先复制 `input_length` 字节到输入缓冲区，再调用 `vofa_push`。`received_at_ms` 是不超过 JavaScript 安全
  整数的 Unix 毫秒值，因此可无损转换为 `f64`。
- `vofa_push` 返回负值表示 guest 错误；非负 `i64` 的高 32 位是输出偏移，低 32 位是输出字节数。输出长度为
  `0` 表示没有帧，否则输出区域必须完整位于已导出的线性内存内且不超过 64 KiB。

输出是 UTF-8 JSON：

```json
{
  "frames": [
    { "values": [1.25, 3.3], "labels": ["temperature", "voltage"] }
  ]
}
```

每批最多 64 帧，每帧必须有 1-16 个有限 JSON 数值。`labels` 可省略；存在时必须与 `values` 等长、单帧内唯一，
每项非空、无首尾空白、最多 64 字符和 256 UTF-8 字节。通道身份由数值数组索引确定；后续帧改变同一索引的
`label` 只更新显示名，不会重映射历史通道。根对象和帧拒绝未知或重复字段。一个批次的所有帧使用同一个
`received_at_ms`；数组顺序表达同一时间戳内的先后，扩展不得依赖宿主人为制造子毫秒时间。

最小、由 Rust 真实运行时测试的 WAT 位于
[`examples/extensions/constant-parser`](../examples/extensions/constant-parser)。

## 执行和资源边界

Wasm 由 Rust 进程内的 `wasmi` 解释器执行。当前配置包括：

- 零 import，因此没有 WASI、宿主函数、网络、文件、独立时钟、随机数或 UI 能力；guest 只能读取宿主传入的
  `received_at_ms` 批次时间参数。自定义 section 被忽略。
- 最多一个 32 位 memory、初始和运行时最多 4 MiB；最多一个 table 和 1024 个 table element。
- 禁用 memory64、multi-memory、reference types、tail calls、custom page sizes 和 wide arithmetic。
- 每次导出调用补充 2,000,000 fuel；值栈和递归深度也有显式上限。
- 同时最多一个检查/启用编译任务和一个 `push`/reset 任务。
- `Module::new` 的 eager 编译受 1 MiB 模块上限和单编译许可保护，但不受导出调用 fuel 约束，也不能被强制中止；
  边界撤权会让迟到结果失效，不会终止已经开始的编译。
- 前端把输入复制并切成最多 64 KiB 的批次；扩展队列单在途，最多 8 批和 512 KiB。
- 所有面向 UI 的扩展错误限制为最多 512 字符和 2048 UTF-8 字节。

故障码包括 `fuel-exhausted`、`memory-limit`、`runtime-trap`、`abi-violation`、`output-invalid` 和
`internal-error`。任一 guest 故障会销毁该运行时并清除授权，但不会停止串口、内置 parser、终端、统计、捕获、
自动应答或数值记录。队列溢出也只停用扩展。

这些限制用于缩小攻击面，不等同于操作系统进程沙箱。解释器、Rust 后端、Tauri/WebView、CSP 和应用安装包都在
可信计算基中；`wasmi` 或宿主实现漏洞仍可能影响应用进程。不要把未知 `.vux` 当作安全文件运行。

## 数据流和会话

内置 parser、终端、统计、捕获和自动应答先按同步路径处理 RX；扩展执行异步消费同一字节的副本，不能替换
或回滚基础链路。入队仍在 `ingestBytes` 末尾同步分批复制，成本与当前 RX 字节数成正比，并受 512 KiB 队列上限
约束。输出使用 `extension:<manifest-id>:<index>` 通道，只进入独立波形分组和扩展统计：

性能门禁用生产分批函数测量 512 KiB 最大输入的 8 次独立复制；Rust 压力测试让真实 Wasmi 运行时连续处理 128 个
64 KiB 批次并在 reset 后复用。前者防止同步入口出现数量级回退，后者验证 8 MiB 连续输入下的资源边界；两者都
不构成未知 guest 或不同机器上的绝对延迟保证。

- 不进入处理图、姿态映射、实时数值 CSV、VUCAP 捕获或回放。
- 清空波形会丢弃清空前仍在途的画面，但仍推进 guest 批次序号；不会重置 guest parser。
- 暂停波形仍推进扩展状态和计数，只停止追加可见点。
- 协议、数据源、连接、串口重连、工作区、回放或应用运行环境边界会撤销会话和授权。
- 进入回放前撤销实时扩展；回放数据绝不会送入 v1 guest。
- reset 等待在途批次结束，调用 `vofa_reset`，推进 generation，并从 sequence 1 重新开始。

包路径、检查结果、manifest、摘要、授权、会话/代次/序号、故障、队列、输出通道及其显隐都不写入工作区、
`localStorage`、VUCAP 或诊断报告。应用重启后必须重新选择、检查和授权。

后端只验证调用参数中恰好包含 `live-rx.read`，不能证明用户在真实界面中点击了授权；用户意图由受信的
WebView/UI 负责。RX 可能包含密钥、设备标识、凭据、未公开协议和客户数据，授权前应按最高敏感级别评估扩展。

## 完整性、身份和供应链

检查阶段计算整个 `.vux` 和解码后 Wasm 的 SHA-256。启用时重新读取包，并要求包摘要与检查结果一致，以绑定
检查和执行内容。SHA-256 不证明作者身份、签名、来源、代码质量或许可证合规；当前没有发布者信任链、撤销机制
或扩展商店。

Vofa-Ultra 安装包的 SBOM、`THIRD_PARTY_NOTICES` 和来源证明只覆盖宿主的锁定运行时依赖，不覆盖用户加载的
`.vux`、其源码、生成工具或间接依赖。扩展发布者应自行提供源码来源、可复核构建、签名/证明及完整许可证材料。

## 打包和校验

先把语言输出编译为不含 import 的 `wasm32-unknown-unknown` 模块，再从仓库根目录运行：

```bash
pnpm extension:pack -- path/to/manifest.json path/to/parser.wasm dist/parser.vux
pnpm extension:verify -- dist/parser.vux path/to/parser.wasm
```

`extension:pack` 校验 Schema、UTF-8/字节边界、SemVer、Wasm v1 头和模块摘要，并产生确定性 JSON。
`extension:verify` 重新校验 canonical 表示、摘要和可选的源模块字节。二者不会证明 ABI exports 可调用；完整验收
必须像仓库示例一样通过真实 Vofa-Ultra Rust 运行时测试。

开发扩展时至少覆盖：任意 RX 分包、跨批半帧、空输出、多帧同时间戳、reset、最大输入/输出、fuel/内存上限、
损坏 JSON、非有限值、标签约束和宿主停用后的迟到结果。不要把故障恢复建立在未文档化的 Wasm、Tauri 或前端
内部行为上。
