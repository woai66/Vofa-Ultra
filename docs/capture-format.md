# VUCAP 捕获文件格式

`.vucap` 是 Vofa-Ultra 的原始会话捕获格式。v1 以小端序保存 RX / TX 原始字节和相对单调时间，v2 在同一
时间线上增加持久命名标记，v3 增加应用/设备摘要、原生串口 RX 流位置，并为文件头、每个时间线条目和完成 footer
增加独立 SHA-256 完整性校验。新录制只写 v3；当前 reader 明确支持 v1、v2 和 v3。文件供后续回放、诊断和转换
任务复用，不保存解析后的波形点，也不依赖当前界面的缓存上限。

## 文件结构

文件由固定前缀、JSON 头、零到多个时间线条目和可选的完成 footer 组成。v1 时间线只有数据记录，v2 / v3 可混排
数据记录和标记；方括号内的 SHA-256 字段仅在 v3 存在：

```text
prefix | header JSON | [header SHA-256] | item [item SHA-256]... | footer [footer SHA-256]
```

### 固定前缀

| 偏移 | 长度 | 类型 | 内容 |
| ---: | ---: | --- | --- |
| 0 | 8 | bytes | magic：`VUCAP\0\r\n` |
| 8 | 2 | u16 LE | 格式版本，v1 / v2 / v3 分别为 `1` / `2` / `3` |
| 10 | 2 | u16 LE | flags，v1 / v2 / v3 必须为 `0` |
| 12 | 4 | u32 LE | JSON 头字节数，最大 64 KiB |

JSON 头使用 UTF-8，字段采用 camelCase：

- `source`：`serial` 或 `simulator`
- `protocol`：`firewater`、`justfloat` 或 `raw`
- `serialConfig`：开始录制时冻结的完整串口参数
- `startedAtUnixMs`：会话起始 Unix 毫秒时间
- `timeUnit`：v1 / v2 / v3 固定为 `microseconds`
- `application`：仅 v3 必需，包含合法 SemVer `version` 和 `buildId`
- `device`：仅 v3 可选，包含 `kind`、可选厂商/产品、成对 VID/PID 和可选 `serialNumberSha256`

v1 / v2 禁止出现 `application` 或 `device`。v3 的 `buildId` 是 `development`，或 7–12 位小写 Git commit 加可选
`-dirty`；它用于定位构建，不是可信构建证明。设备信息只在开始原生串口录制时从当前枚举结果冻结，模拟器不得携带
该字段。USB 序列号先规范化，再只保存 64 位小写 SHA-256，不保存原文；非 USB 设备不得携带 VID、PID 或序列号
摘要。摘要是可关联同一设备的稳定化名，低熵序列号仍可能被枚举反推，因此不能把它当作匿名化结果。

当前 v3 不保存工作区、处理图、命令、扩展或 parser 构建摘要。原始字节回放可由文件复现，但派生曲线仍取决于
打开文件时的当前配置；格式不能据此宣称分析结果完全确定。

v3 在 JSON 头之后追加 32 字节 SHA-256，输入为从 magic 开始的 16 字节固定前缀与原始 JSON 字节的顺序拼接。
reader 在解析 JSON 前验证该摘要；摘要缺失视为截断，摘要不匹配视为文件损坏。

### 数据记录

v1 / v2 的固定记录头为 16 字节，v3 为 48 字节。表内偏移相对本条记录起点：

| 偏移 | 长度 | 版本 | 类型 | 内容 |
| ---: | ---: | --- | --- | --- |
| 0 | 1 | 全部 | u8 | tag：`0x01` |
| 1 | 1 | 全部 | u8 | direction：`0` 为 RX，`1` 为 TX |
| 2 | 2 | v1 / v2 | u16 LE | reserved，必须为 `0` |
| 2 | 2 | v3 | u16 LE | flags；`0x0001` 表示存在 RX 流位置，其他位必须为 `0` |
| 4 | 8 | 全部 | u64 LE | 相对捕获开始的单调微秒时间 |
| 12 | 4 | 全部 | u32 LE | payload 字节数，最大 64 KiB |
| 16 | 8 | v3 | u64 LE | `connectionGeneration` |
| 24 | 8 | v3 | u64 LE | 连接代次内从 `0` 开始的 `sequence` |
| 32 | 8 | v3 | u64 LE | 连接代次内、该块首字节的 `streamOffset` |
| 40 | 8 | v3 | u64 LE | 相对当前串口 worker 启动的 `receivedAtMonotonicUs` |
| 16 / 48 | N | v1/v2 / v3 | bytes | 原始 payload |
| 48+N | 32 | v3 | bytes | 完整 v3 记录头与 payload 的 SHA-256 |

相对时间来自单调时钟，不受系统时间校准影响。TX 在每次串口 `write` 成功后记录实际写入的字节分片；一次
发送可能产生多条 TX record，读取方必须按记录顺序拼接才能恢复线上字节流，不能把 record 边界解释为发送
命令边界。RX 在进入 Base64 事件边界前记录，因此原生串口采集不需要让原始数据绕 WebView 一圈。

`source=serial` 时，每条 RX 必须设置 `0x0001` 并填写四个流字段，TX 必须清空 flag 和 32 字节扩展区；
`source=simulator` 时，所有 RX / TX 都必须清空 flag 和扩展区。writer 在入队前冻结并核对数据生产者来源，reader
也会根据文件头重新验证每条记录；来源与流元数据不匹配时整条记录按损坏拒绝。同一 `connectionGeneration` 内，
后续记录必须满足 `sequence = 前一序号 + 1`、`streamOffset = 前一偏移 + 前一 payload 长度`，且接收单调时间
不得回退。连接代次只能前进；新代次重新建立序号、偏移和时间基线，因此捕获在连接中途开始时，首条记录不要求
从零开始。

v3 记录摘要覆盖完整 48 字节头和 payload。reader 在交付记录前先验证字段、摘要及跨记录连续性；摘要不匹配按
损坏拒绝，校验块截断时该条目不会进入可恢复的完整前缀。流位置证明的是 Rust 已成功读取之后、写入 VUCAP 的块
序列，不证明 USB、驱动或操作系统在 `read` 之前没有丢数据。

### 时间线标记（v2 / v3）

| 长度 | 类型 | 内容 |
| ---: | --- | --- |
| 1 | u8 | tag：`0x02` |
| 1 | u8 | color：`0..6` 对应 gray、red、orange、yellow、green、blue、purple |
| 2 | u16 LE | reserved，必须为 `0` |
| 8 | u64 LE | 相对会话开始的单调微秒时间 |
| 4 | u32 LE | UTF-8 标签字节数，最大 256 字节 |
| N | bytes | UTF-8 标签 |
| 32 | bytes | 以上完整标记的 SHA-256，仅 v3 存在 |

标签去除首尾空白后必须包含 1 到 64 个 Unicode 字符，不允许控制字符。每个文件最多 512 个标记。标记与
RX / TX 记录使用同一个 writer 队列和单调时钟基准，因此文件顺序就是用户看到的数据与标记顺序；跨类型时间戳
必须单调不减，允许相同时间戳。

v3 标记摘要覆盖 tag、color、reserved、时间戳、标签长度和原始 UTF-8 标签字节。

### 完成 footer

| 长度 | 类型 | 内容 |
| ---: | --- | --- |
| 1 | u8 | tag：`0xff` |
| 7 | bytes | reserved，v1 / v2 / v3 必须全为 `0` |
| 8 | u64 LE | payload 总字节数 |
| 8 | u64 LE | 数据记录总数 |
| 8 | u64 LE | 标记总数，仅 v2 / v3 存在 |
| 32 | bytes | 以上完整 footer 的 SHA-256，仅 v3 存在 |

v1 footer 在数据记录总数后结束，v2 / v3 footer 继续携带标记总数，v3 再追加 footer 摘要。主动停止会 flush、
同步并写入 footer。磁盘错误、队列溢出、显式中止或进程异常不会伪造 footer；reader 可读取最后一个完整且校验
通过的条目，并把缺失 footer 的文件标记为未完成。未知版本、错误 magic、超长头部、超长条目、截断条目和
SHA-256 不匹配必须返回确定错误，不能按当前版本猜测解析。

这些 SHA-256 是无密钥完整性校验，用于发现存储、传输或内存中的非恶意位翻转，不是数字签名。能够修改文件的
攻击者也能重新计算摘要；应用版本、构建 ID 和设备摘要也都是自述元数据，因此 v3 不提供来源认证、防恶意篡改
或软件供应链证明。

## 写入边界

- Rust writer 使用独立线程，串口 worker 只执行非阻塞 `try_send`。
- 队列同时限制命令数和累计 payload / 标签字节数；磁盘落后时停止录制，但保持串口连接运行。
- 前端不持有文件内容。Tauri 模拟器的 RX / TX 与标记通过 1 MiB 有界 FIFO 串行写入同一个 recorder；模拟器
  IPC 只能写入 `source=simulator` 的当前会话，不能向串口捕获混入无流位置的 RX 或 TX。
- 捕获文件默认写入系统下载目录下的 `Vofa-Ultra` 文件夹；不可用时回退到应用数据目录的 `recordings`。
- 桌面端可为当前运行会话选择原始捕获与数值 CSV 共用的现有绝对目录，路径最多 4096 个字符；显式目录不可用时
  拒绝启动且不回退。
- 文件名由应用生成，并在创建阶段避让已有 `.vucap`、`.csv` 或 `.csv.part`，不接受任意目标文件名。
- 浏览器预览不开放文件录制，也不增加通用文件系统权限。

## 回放边界

- 打开时流式扫描完整文件，不构建全量数据记录索引；倒退时间戳、错误 footer 统计、校验失败和未知条目会被拒绝。
- 缺少 footer 或尾部截断时，只回放扫描阶段已验证的完整条目前缀，并在界面中明确标记为不完整。
- 扫描阶段最多收集 512 个标记并通过一次性会话事件发送；标记不会进入数据批次或改变 ACK 协议。
- 回放时间轴显示标记刻度和有界列表。暂停、就绪或完成状态可点击标记定位；播放和定位期间禁用该操作。
- 播放重新打开文件，只保留 reader、一个预读 record 和一个待确认批次。
- 批次上限为 128 KiB、128 条记录或 16 ms 捕获跨度，前端同步处理并 ACK 后才读取下一批。
- 会话、代次和序列号共同过滤停止或重播后的迟到事件；暂停和停止可立即唤醒等待中的 worker。
- 倍速是回放会话参数，不写入捕获文件；五档切换不改变代次、序列号或待确认批次。
- 前端只通过原生文件选择器取得路径，文件读取仍由 Rust 完成，不授予 WebView 通用文件系统权限。

## 导出边界

- 导出直接在 Rust worker 中流式迭代 `CaptureReader`，IPC 只发送进度和终态，不传输 payload。
- CSV 每条记录包含 `record_index`、`timestamp_us`、`unix_time_us`、`direction`、`payload_length` 和
  `payload_hex`。不输出不可信文本字段，避免电子表格公式注入和控制字符歧义。
- JSONL 首行为 capture metadata，中间为时间线条目，末行为完整性和计数 summary。v1 schema 保持不变；v2+
  使用 Base64 record 和 `type="marker"` 行，summary 增加 `processedMarkers`；带 v3 RX 流位置的 record 另含
  `rxStream` 对象。CSV 与 BIN 不增加该元数据，保持既有输出契约。
- 方向过滤只过滤 RX / TX record，不移除 v2+ marker。CSV 和 BIN 明确跳过标记，保持既有纯数据契约；BIN 只按
  记录顺序拼接显式选择的 RX 或 TX payload，不允许双向输出，因为裸字节流无法保留方向。
- 不完整文件默认拒绝；用户明确允许后只提交已验证的完整条目前缀，并标记 `sourceComplete=false`。
- 输出先写目标同目录临时文件并同步，再通过备份/恢复流程替换目标。取消、损坏或写入失败不提交半成品。
- 导出前后比较源文件长度和修改时间；活动录制期间禁止启动导出，回放可使用独立文件句柄并行读取。

## 实时数值 CSV

实时数值 CSV 不是 `.vucap` 的另一种编码，也不同于上述捕获导出。它只接受 FireWater / JustFloat 实时解析出的
有限标量；基础帧与可用的处理图输出分别写入 `base`、`derived` 行。Raw Data、TX 和历史回放不进入该文件。

文件使用 UTF-8 BOM、CRLF 和固定表头：

```text
sample_index,timestamp_unix_us,elapsed_us,channel_kind,channel_id,channel_name,value
```

- `sample_index`：从 0 开始、按文件行递增的可靠顺序。
- `timestamp_unix_us`：协议帧完成时的 Unix 微秒时间；同一输入 chunk 完成的多帧可以相同。
- `elapsed_us`：Rust 接受该 IPC 批次时相对日志启动的单调微秒时间；同批行可以相同。
- `channel_kind`：`base` 或 `derived`。
- `channel_id`：基础通道为 `channel-0..15`，派生通道为稳定的 `derived:<output-id>`。
- `channel_name`：帧标签、基础回退名或处理图输出名。
- `value`：Rust `f64` 的有限十进制表示。

动态出现、消失或改名的通道不会改变列集合。文本按 RFC 4180 转义；控制字符被拒绝，首个非空白字符为
`= + - @` 时在字段前加单引号，避免电子表格公式注入。前端每批最多发送 256 行，同时限制 1 MiB 与 2,048 行；
Rust 单批最多接受 512 行，writer 队列限制 64 批、4 MiB 与 4,096 行。任何溢出都进入 `error`，不会静默丢行。

文件自动写入与捕获相同的目录策略，先以唯一 `.csv.part` 创建。正常停止会 flush、`sync_all` 后无覆盖提交为
`.csv`；若同名最终文件在记录期间出现，提交会失败并保留 `.part` 和既有目标。失败或主动中止也会保留 `.part`
的可诊断前缀并报告实际路径，底层 I/O 故障时末行可能不完整。数值日志和
`.vucap` 生命周期独立，可以并行，单方失败不影响另一方或实时连接。

## 兼容策略

reader 必须先验证 magic 和版本，再分配 JSON、payload 或标签缓冲。当前 reader 按版本解析 v1 / v2 / v3，把
v1 的 `marker_count` 归一化为 0；v1 / v2 保持 16 字节记录头且没有条目摘要，v3 使用 48 字节记录头并读取校验块。
writer 只产生 v3。这里的“兼容旧版 reader”指升级后的 reader 继续读取既有 v1 / v2 文件，不代表旧版程序能读取
v3。旧版 reader 应以未来版本错误明确拒绝 v3，而不是尝试忽略扩展头、校验块或按 v2 猜测条目边界。

后续版本如改变条目语义，应继续提升格式版本并保留旧格式读取路径，不能复用 flags 静默改变既有含义。

`protocol` 同时是工作区和 VUCAP 的持久化 wire ID。合法 ID 只能追加，不能改名、删除、复用或在不提升格式
版本的情况下改变既有含义。Rust reader 独立校验白名单；旧版本拒绝包含新 ID 的文件，不能把未知值降级为 Raw。
跨格式支持矩阵、通知周期与移除门禁见[兼容性与弃用政策](compatibility.md)。
