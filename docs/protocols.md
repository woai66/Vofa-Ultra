# 内置协议贡献契约

Vofa-Ultra 的协议扩展点面向随仓库构建、评审和测试的内置协议。当前不提供运行时注册、第三方脚本、Wasm、
动态包加载或稳定插件 ABI；协议代码与应用拥有相同权限，因此必须先通过本仓库的输入边界和回归测试。

## 注册模型

`src/types/serial.ts` 中的 `PROTOCOL_IDS` 是前端协议 ID 的唯一来源，`ProtocolKind` 由它派生。
`src/core/protocols.ts` 中的静态注册表为每个 ID 提供：

- `id`：持久化和捕获文件使用的 wire ID。
- `displayName` 与 `description`：协议选择器和状态展示文案。
- `createParser()`：每次返回状态完全独立的增量解析器。
- `encodeSimulatorSample()`：让浏览器预览能贯通该协议的数据链路。
- `replaySeekMode`：声明回放定位是否具备可靠同步边界。

新增协议时必须追加新的 ID，不能重命名、删除或复用已有 ID。工作区 v1 和 VUCAP v1 都会持久化该字符串；
改变含义会让旧文件被静默误读。旧版本拒绝未知 ID 是预期的前向不兼容行为。

Rust 的 `SUPPORTED_CAPTURE_PROTOCOLS` 必须独立更新。它不是前端注册表的生成副本，而是 Tauri 对 WebView 和外部
VUCAP 输入的信任边界。新增结构化协议默认使用 `replaySeekMode: "unsupported"`；只有格式具有可验证同步点、
前后端定位语义和测试同时完成后，才能开放 seek。当前只有 Raw Data 支持按 record 边界定位。

## 解析器契约

解析器实现 `push(bytes, timestamp)` 与 `reset()`。`timestamp` 是完成协议帧的那个 chunk 的时间，不是首字节时间。
实现必须满足以下约束：

- 同步、确定、无副作用；相同字节、分包和时间戳产生相同结果。
- 接受任意分包，包括空 chunk、逐字节输入和跨 chunk 帧尾；只输出完整帧。
- 不因损坏、随机或超长输入抛异常；丢弃当前损坏单元后能在明确同步点恢复。
- 残片缓存有硬上限，且 `reset()` 清空残片、解码器和丢弃状态；重复调用保持幂等。
- 每帧包含 1 到 16 个有限数值，不能输出 `NaN` 或正负无穷。
- `labels` 要么省略，要么与 `values` 等长；单个非空标签最多 64 个 UTF-16 code unit，不能含分隔符或控制字符。
- 工厂每次创建独立实例，不能通过模块级可变状态让实时、回放或测试链路相互污染。

内置 FireWater 最多保留 16,384 个 UTF-16 code unit 的未闭合文本行；JustFloat 最多保留 64 字节数据和
3 字节帧尾前缀。新协议应按自身格式选择更小的可解释上限，不能依赖串口或 IPC 上游“通常不会给大 chunk”。

## 最小实现模板

模板用于仓库内实现，不是可安装插件接口：

```ts
class ExampleParser implements ProtocolParser {
  private pending = new Uint8Array();

  push(bytes: Uint8Array, timestamp: number): ParsedFrame[] {
    // 追加时立即执行格式上限检查，只返回已验证的完整帧。
    return parseCompleteFrames(bytes, timestamp);
  }

  reset(): void {
    this.pending = new Uint8Array();
  }
}
```

注册项必须同时提供模拟器编码器，确保下列测试可以成立：

```ts
const definition = getProtocolDefinition("example");
const bytes = definition.encodeSimulatorSample([1, 2, 3], 0);
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
6. 模拟器编码结果能被对应解析器消费；Raw 明确产生零个波形帧。

不要使用墙钟性能断言。对于 CPU 或内存风险，使用固定输入规模、显式缓存上限和确定的输出数量进行验证。

## 修改清单

一个新增协议 PR 至少应修改并说明：

- `PROTOCOL_IDS` 与静态协议注册表。
- parser、模拟器编码器和协议合规夹具。
- Rust 捕获协议白名单及其测试。
- VUCAP 格式文档中的合法 ID，以及 README 中面向用户的输入说明。
- seek 是否安全；若不是，保持 `unsupported` 并验证前后端都拒绝。

提交前运行 `pnpm check`、Rust 格式/Clippy/测试和 `pnpm test:e2e`。协议来自公开实现时，还要在 PR 中记录来源、
规格链接和许可证；不要直接移植许可证不兼容的源码。
