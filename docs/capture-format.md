# VUCAP 捕获文件格式

`.vucap` 是 Vofa-Ultra 的原始会话捕获格式。v1 以小端序保存 RX / TX 原始字节和相对单调时间，供后续
回放、诊断和转换任务复用。文件格式不保存解析后的波形点，也不依赖当前界面的缓存上限。

## 文件结构

文件由固定前缀、JSON 头、零到多条数据记录和可选的完成 footer 组成：

```text
prefix | header JSON | record... | footer
```

### 固定前缀

| 偏移 | 长度 | 类型 | 内容 |
| ---: | ---: | --- | --- |
| 0 | 8 | bytes | magic：`VUCAP\0\r\n` |
| 8 | 2 | u16 LE | 格式版本，v1 为 `1` |
| 10 | 2 | u16 LE | flags，v1 必须为 `0` |
| 12 | 4 | u32 LE | JSON 头字节数，最大 64 KiB |

JSON 头使用 UTF-8，字段采用 camelCase：

- `source`：`serial` 或 `simulator`
- `protocol`：`firewater`、`justfloat` 或 `raw`
- `serialConfig`：开始录制时冻结的完整串口参数
- `startedAtUnixMs`：会话起始 Unix 毫秒时间
- `timeUnit`：v1 固定为 `microseconds`

### 数据记录

| 长度 | 类型 | 内容 |
| ---: | --- | --- |
| 1 | u8 | tag：`0x01` |
| 1 | u8 | direction：`0` 为 RX，`1` 为 TX |
| 2 | u16 LE | reserved，v1 必须为 `0` |
| 8 | u64 LE | 相对会话开始的单调微秒时间 |
| 4 | u32 LE | payload 字节数，最大 64 KiB |
| N | bytes | 原始 payload |

相对时间来自单调时钟，不受系统时间校准影响。TX 在每次串口 `write` 成功后记录实际写入的字节分片；一次
发送可能产生多条 TX record，读取方必须按记录顺序拼接才能恢复线上字节流，不能把 record 边界解释为发送
命令边界。RX 在进入 Base64 事件边界前记录，因此原生串口采集不需要让原始数据绕 WebView 一圈。

### 完成 footer

| 长度 | 类型 | 内容 |
| ---: | --- | --- |
| 1 | u8 | tag：`0xff` |
| 7 | bytes | reserved，v1 必须全为 `0` |
| 8 | u64 LE | payload 总字节数 |
| 8 | u64 LE | 数据记录总数 |

主动停止会 flush、同步并写入 footer。磁盘错误、队列溢出、显式中止或进程异常不会伪造 footer；reader 可读取
最后一条完整记录，并把缺失 footer 的文件标记为未完成。未知版本、错误 magic、超长头部、超长记录和截断
记录必须返回确定错误，不能按当前版本猜测解析。

## 写入边界

- Rust writer 使用独立线程，串口 worker 只执行非阻塞 `try_send`。
- 队列同时限制记录数和累计 payload 字节数；磁盘落后时停止录制，但保持串口连接运行。
- 前端不持有文件内容。Tauri 模拟器通过 1 MiB 有界 IPC 队列串行写入同一个 recorder。
- 捕获文件自动写入系统下载目录下的 `Vofa-Ultra` 文件夹；不可用时回退到应用数据目录的 `recordings`。
- 浏览器预览不开放文件录制，也不增加通用文件系统权限。

## 回放边界

- 打开时流式扫描完整文件，不构建全量记录索引；倒退时间戳、错误 footer 统计和未知记录会被拒绝。
- 缺少 footer 或尾部截断时，只回放扫描阶段已验证的完整记录前缀，并在界面中明确标记为不完整。
- 播放重新打开文件，只保留 reader、一个预读 record 和一个待确认批次。
- 批次上限为 128 KiB、128 条记录或 16 ms 捕获跨度，前端同步处理并 ACK 后才读取下一批。
- 会话、代次和序列号共同过滤停止或重播后的迟到事件；暂停和停止可立即唤醒等待中的 worker。
- 前端只通过原生文件选择器取得路径，文件读取仍由 Rust 完成，不授予 WebView 通用文件系统权限。

## 兼容策略

reader 必须先验证 magic 和版本，再分配 JSON 或 payload 缓冲。v1 reader 不接受未来版本；后续版本如改变记录
语义，应提升格式版本并保留旧 reader，而不是复用 flags 静默改变既有含义。
