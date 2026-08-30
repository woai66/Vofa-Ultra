# 内置协议贡献契约

本文只定义随仓库构建、评审和测试的内置协议。内置协议代码与应用拥有相同权限，因此必须先通过本仓库的输入
边界和回归测试。桌面端另有[实验性 Wasm 实时附加解析器](extensions.md)，但它不注册新的持久 `protocol` wire ID、
不替换内置 parser，也不属于本文的稳定兼容承诺；当前没有 JavaScript、原生动态库或稳定插件 ABI。

## 注册模型

`src/types/serial.ts` 中的 `PROTOCOL_IDS` 是前端协议 ID 的唯一来源，`ProtocolKind` 由它派生。
`src/core/protocols.ts` 中的静态注册表为每个 ID 提供：

- `id`：持久化和捕获文件使用的 wire ID。
- `displayName` 与 `description`：协议选择器和状态展示文案。
- `createParser()`：每次返回状态完全独立的增量解析器。
- `encodeSimulatorSample?()`：可选；结构化协议可用它接入内置波形模拟。
- `replaySeekMode`：声明回放定位是否具备可靠同步边界。

新增协议时必须追加新的 ID，不能重命名、删除或复用已有 ID。工作区 v1/v2 和 VUCAP v1 都会持久化该字符串；
改变含义会让旧文件被静默误读。旧版本拒绝未知 ID 是预期的前向不兼容行为。

当前稳定承诺覆盖这些持久 wire ID 和本文的解析行为，不代表 TypeScript 模块或实验性 Wasm ABI 稳定。完整
版本矩阵与弃用门禁见[兼容性与弃用政策](compatibility.md)。

Rust 的 `SUPPORTED_CAPTURE_PROTOCOLS` 必须独立更新。它不是前端注册表的生成副本，而是 Tauri 对 WebView 和外部
VUCAP 输入的信任边界。`replaySeekMode` 的 `record-boundary` 只适用于 record 本身就是安全起点的协议，
`protocol-boundary` 表示 Rust 能验证并吸附协议同步点，`unsupported` 则必须由前后端共同拒绝。新增结构化协议
默认使用 `unsupported`；只有同步规则、record 内偏移、取消语义和前后端测试同时完成后，才能开放 seek。

当前 Raw Data 使用 `record-boundary`。FireWater / JustFloat 使用 `protocol-boundary`：前者以 RX `LF` 后为同步点，
后者以 RX 完整 `00 00 80 7F` 后为同步点，TX 交错不改变 RX 同步状态。结构化定位丢弃目标处可能残缺的第一个
单元并返回实际吸附时间，不允许仅在 UI 中声明能力而让 Rust 把任意 record 起点当成安全边界。

Raw Data 只承载真实串口或回放中的原始字节，不执行结构化解析，也不生成数值波形。它不提供
`encodeSimulatorSample`，内置波形模拟只支持 FireWater 和 JustFloat。若未来增加 Raw 模拟，输入模型必须是用户
明确提供的 HEX 载荷和发送间隔，并按原始字节发送；不能为 Raw 隐式定义样本序号、浮点载荷或其他私有帧格式。

## 解析器契约

解析器实现 `push(bytes, timestamp)`、`getHealthSnapshot()`、`clearHealth()` 与 `reset()`。`timestamp` 是完成协议帧的
那个 chunk 的时间，不是首字节时间。实现必须满足以下约束：

- 同步、确定、无副作用；相同字节、分包和时间戳产生相同结果。
- 接受任意分包，包括空 chunk、逐字节输入和跨 chunk 帧尾；只输出完整帧。
- 不因损坏、随机或超长输入抛异常；丢弃当前损坏单元后能在明确同步点恢复。
- 残片缓存有硬上限，且 `reset()` 清空残片、解码器、丢弃状态和健康统计；重复调用保持幂等。
- 每帧包含 1 到 16 个有限数值，不能输出 `NaN` 或正负无穷。
- `labels` 要么省略，要么与 `values` 等长；单个非空标签最多 64 个 UTF-16 code unit，不能含分隔符或控制字符。
- 工厂每次创建独立实例，不能通过模块级可变状态让实时、回放或测试链路相互污染。

健康快照固定包含成功帧数、丢弃帧数、重同步次数、各原因计数、最近原因和最近时间。计数饱和于
`0xFFFF_FFFF`，不能回绕，也不能保存错误事件数组或被拒绝的原始载荷。内置原因码为：

- `unit-too-long`：单元超过该协议缓存或帧长度上限。
- `too-many-channels`：完整单元声明了超过 16 个通道。
- `invalid-format`：单元为空帧、字段缺失或不满足基本语法；FireWater 纯空行不算错误。
- `invalid-label`：FireWater 标签超过上限或包含被禁止的分隔符、控制字符。
- `non-finite-value`：数值不是有限数，或 JustFloat 解码得到 `NaN` / 无穷。
- `misaligned-length`：JustFloat 帧体没有按 4 字节 `float32` 对齐。

同一个损坏单元无论如何分包只计一次。只有解析器先进入超长丢弃状态、之后找到明确同步边界时，才增加一次
重同步；已经在完整边界上判断为普通格式错误的单元不额外计重同步。`getHealthSnapshot()` 返回不能修改内部状态的
快照，并在诊断未变化时复用同一引用，避免半帧或 Raw chunk 触发无意义界面更新。`clearHealth()` 只清计数并保留
正在等待的半帧，`reset()` 同时清除解析状态和计数。

实时与回放必须使用不同 parser 实例和健康快照。协议、数据源、工作区、手动连接、自动重连流边界，以及回放
会话或时间线改变时，重置对应实例；暂停波形或终端不能停止诊断。Raw Data 返回恒为零的快照，界面显示“不适用”。

### FireWater 文本语法

FireWater 以 LF 结束一帧，CRLF 中的 CR 会随整行 trim。每帧由逗号或空白分隔 1 到 16 个字段，字段有三种形式：

- 无标签有限数值，例如 `1.25,-2,3`。
- 冒号命名数值，例如 `temperature:23.5 voltage:3.30`。
- 等号命名数值，例如 `yaw=1.234 pitch=0.567 cur=0.8`。

同一帧的命名字段只能选择 `:` 或 `=` 一种分隔符；无标签数值可以与选定的命名形式共存。重复分隔符、混用两种
命名形式、空标签、空值和逗号空字段均以 `invalid-format` 丢弃整帧。标签不能包含空白、逗号、冒号、等号或控制
字符，且仍受 64 个 UTF-16 code unit 上限约束。数值必须能由 `Number` 解析为有限值；`NaN` 和
`Infinity` 以 `non-finite-value` 拒绝。纯空行被忽略，不增加健康计数。

内置 FireWater 最多保留 16,384 个 UTF-16 code unit 的未闭合文本行；JustFloat 最多保留 64 字节数据和
3 字节帧尾前缀。新协议应按自身格式选择更小的可解释上限，不能依赖串口或 IPC 上游“通常不会给大 chunk”。

## 最小实现模板

模板用于仓库内实现，不是可安装插件接口：

```ts
class ExampleParser implements ProtocolParser {
  private pending = new Uint8Array();
  private readonly health = new ProtocolHealthTracker();

  push(bytes: Uint8Array, timestamp: number): ParsedFrame[] {
    // 追加时立即执行格式上限检查，并按结果调用 accept/drop/resync。
    const frames = parseCompleteFrames(bytes, timestamp, this.health);
    return frames;
  }

  getHealthSnapshot(): ProtocolHealthSnapshot {
    return this.health.getSnapshot();
  }

  clearHealth(): void {
    this.health.clear();
  }

  reset(): void {
    this.pending = new Uint8Array();
    this.clearHealth();
  }
}
```

需要接入内置波形模拟的结构化协议才提供模拟器编码器，并确保下列测试可以成立：

```ts
const definition = getProtocolDefinition("example");
const encodeSimulatorSample = definition.encodeSimulatorSample;
if (!encodeSimulatorSample) {
  throw new Error("example 不支持波形模拟");
}
const bytes = encodeSimulatorSample([1, 2, 3], 0);
const frames = definition.createParser().push(bytes, 1_000);
expect(frames[0]?.values).toEqual([1, 2, 3]);
```

实际实现不要复制示例中的占位 `parseCompleteFrames`；应在协议模块内完成有界增量状态机。

## 合规夹具

每个结构化协议都要提供有效流、期望帧、损坏前缀、超长前缀和恢复帧，并覆盖：

1. 单 chunk、逐字节、所有单切点和固定种子随机分包结果一致。
2. 多帧顺序正确，跨 chunk 完成的帧使用完成 chunk 的时间戳。
3. 半帧后 `reset()` 不产生幽灵帧，重复 reset 幂等，两个工厂实例互不影响。
4. 空、损坏、超长和固定规模随机字节不抛异常，随后能在同步点恢复。
5. 输出通道数、有限数值和标签对齐满足上述边界。
6. 声明模拟能力的结构化协议，其编码结果能被对应解析器消费；Raw 不声明该能力且始终产生零个波形帧。
7. 若开放 seek，帧尾所有切点、record 内多帧、TX 交错、重复时间戳和无后续同步点均不产生截断帧。
8. 合法、损坏和超长单元的健康计数与分包方式无关；原因、最近时间和重同步次数精确一致。
9. `clearHealth()` 保留半帧，`reset()` 同时清半帧与统计，计数达到上限后保持饱和。

不要使用墙钟性能断言。对于 CPU 或内存风险，使用固定输入规模、显式缓存上限和确定的输出数量进行验证。

## 修改清单

一个新增协议 PR 至少应修改并说明：

- `PROTOCOL_IDS` 与静态协议注册表。
- parser、可选模拟器编码器和协议合规夹具。
- Rust 捕获协议白名单及其测试。
- VUCAP 格式文档中的合法 ID，以及 README 中面向用户的输入说明。
- seek 是否安全；若开放，Rust 同步扫描器与端到端吸附反馈必须一并实现，否则保持 `unsupported`。

提交前运行 `pnpm check`、Rust 格式/Clippy/测试和 `pnpm test:e2e`。协议来自公开实现时，还要在 PR 中记录来源、
规格链接和许可证；不要直接移植许可证不兼容的源码。
