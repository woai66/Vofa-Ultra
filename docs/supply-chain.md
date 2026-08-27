# 供应链发布说明

Vofa-Ultra 当前在本地为 Windows x64 目标生成软件物料清单和第三方许可证材料。项目不使用线上构建或自动
聚合资产，首个 Beta 的 NSIS 候选包及其校验材料由维护者在 Windows 上生成并人工核对。

## 输入与范围

生成器只读取仓库清单、锁定依赖图和包内元数据：

- 严格解析 `pnpm-lock.yaml` v9，从根 importer 的 `dependencies` 和 `optionalDependencies` 遍历
  `snapshots`；`node_modules` 只用于确认真实 optional 包及读取包自身元数据和法律文本。
- `cargo metadata --frozen --locked --filter-platform <target>` 提供当前 Rust 目标的正常依赖闭包。
- `package.json`、`tauri.conf.json` 和 `Cargo.toml` 的名称、版本及项目许可证必须一致。
- npm 开发依赖和 optional peer、Cargo `dev`/`build` 依赖及不适用于当前目标的 Cargo 分支不会进入
  运行时 SBOM。

生成前应执行 `pnpm install --frozen-lockfile` 和目标级 `cargo fetch --locked --target <target>`。生成器不查询
许可证聚合网站，也不会用网络结果覆盖包自身声明。required 包、许可证元数据或冻结 Cargo 图缺失时直接失败；
未安装的真实 optional 包不会进入该目标的清单。

宿主内置的 Wasmi 运行时及其锁定 Cargo 依赖属于上述闭包，会进入对应目标的 SBOM 和 NOTICE。用户运行时选择的
`.vux` 文件不属于应用构建输入，因此不进入宿主 SBOM、`THIRD_PARTY_NOTICES` 或 `SHA256SUMS`；扩展源码、
编译器、间接依赖、许可证正文和发布者身份均由扩展发布者负责。manifest 的 `license`
只是作者声明，宿主门禁不会把它当作已审核 SPDX 证据。详见[实验性 Wasm 扩展](extensions.md)。

## 产物

当前目标会生成三份文件：

- `vofa-ultra-<target-triple>.cdx.json`：CycloneDX 1.6 JSON，包含 Package URL 和依赖边。
- `THIRD_PARTY_NOTICES-<target-triple>.txt`：组件、声明许可证、实际选择分支、上游地址及法律文本。
- `SUPPLY_CHAIN_SHA256SUMS`：前两份文件的 SHA-256。

本地 `package:collect` 收集安装包和配套材料，但本地产物仍需人工验证，不能视为正式 Release 已通过。

SBOM 记录完整 Rust target，并绑定 `package.json`、`pnpm-lock.yaml`、`Cargo.toml`、`Cargo.lock` 和策略文件的
SHA-256。NOTICE 原文按内容 SHA-256 去重，同时记录精确 purl。扫描范围包括顶层 `LICENSE`/`LICENCE`、
`COPYING`、`NOTICE`、`COPYRIGHT`、`AUTHORS`、`PATENTS`、`UNLICENSE` 及 Cargo 声明的包内 `license_file`。

缺少许可证正文默认终止生成。正文必须在规范化后按许可证边界截取，并命中策略中已审核的完整条款 SHA-256；
关键句、截断文本、单独链接、SPDX 标识或 SPDX package metadata 均不算条款。例外只能精确到 purl 和版本，并引用
仓库内固定文本；来源 URL、文件 SHA-256、选择许可证和审核原因均由策略绑定。对 `OR` 表达式，生成器只会选择有
完整正文证据的允许分支；`AND` 的每个许可证及例外都必须有证据。升级依赖版本不会继承旧审核，正文指纹变化也会
要求重新审核。

Tauri 在 `beforeBuildCommand` 中生成供应链文件，并把同一目录作为应用资源嵌入安装包。`package:collect` 随后验证
CycloneDX Schema、完整 target、项目元数据、输入摘要、精确 NOTICE inventory 和供应链校验值，再从该 target
专属 bundle 目录收集安装包。当前本地流程会验证供应链原文件和项目 `LICENSE`。

`pnpm tauri build` 会在非 debug 构建中为 rustc 注入路径重映射，把项目目录和 Cargo Home 的解析路径及真实路径
分别映射为稳定的 `/workspace` 和 `/cargo-home`。包装层保留调用方已有的 encoded rustflags；只有普通
`RUSTFLAGS` 时才按 Cargo 的参数规则转换，开发服务器和 debug 构建不受影响。正式候选包必须经过该入口，
不能用裸 `tauri build` 或 `cargo build` 绕过。

复制安装包前，`package:collect` 会扫描同一 release 目录中的裸主程序，拒绝项目目录或 Cargo Home 的解析路径、
真实路径、正反斜杠变体及 UTF-8/UTF-16LE 表示。检查会扫描未压缩的可执行文件，不把 NSIS 安装包的外层压缩
视为脱敏；错误也不会回显命中的本机路径。这项检查防止 Rust panic/source-location 字符串泄露
构建者目录，但不等同于任意隐私数据扫描，也不使安装包自动可复现。

每次非 debug 的 `pnpm tauri build` 开始前，包装层只清理本次 target 的生成型 `release/bundle` 目录。Windows
Beta 只接受本轮生成的 NSIS `.exe`；缺少该文件时，收集器会拒绝继续。这能阻止旧安装包混入候选目录，
但不能证明压缩安装包内的主程序与当前裸主程序完全一致。

未来是否恢复线上构建或其他平台发布，等待 Windows 版本稳定后再独立评估；它们不属于首个 Beta 的发布门槛。

## 许可证策略

[`supply-chain-policy.json`](../supply-chain-policy.json) 是唯一允许列表。SPDX 语法由锁定版本的
`spdx-expression-parse` 解析；旧 Cargo 元数据中的 `MIT/Apache-2.0` 等写法只允许通过文件中逐项审核的别名
转换，其他非标准表达式会失败。

`OR` 表达式选择策略允许的优先分支，`AND` 要求所有分支都允许，`WITH` 还要求例外标识在允许列表中。例如
`MIT OR GPL-3.0-only` 明确选择 MIT，而单独的 GPL/AGPL/SSPL 或未知 `LicenseRef` 会被拒绝。

MPL-2.0 是显式允许、但必须逐 purl 和版本审核的文件级弱 copyleft 许可证。当前 Tauri/serialport 依赖图中的
MPL 组件均记录在 `reviewedComponents`；任何新增或升级组件都会令门禁失败，直到完成审核。若项目以后 patch 或
复制 MPL 覆盖文件，PR 与 Release 还必须保存相应源码和补丁，不能仅依赖此清单。

## 可重复边界

供应链 JSON 不含当前时间、随机 UUID 或绝对路径，组件、依赖边和文本使用稳定代码点排序。相同显式输入连续
序列化应逐字节一致；工具测试覆盖图遍历、工具输出解析和排序。

这不代表完整安装包已经可复现。开发者工具链、系统库、平台 WebView 和签名环境仍会漂移；Windows WebView2
Runtime 和未显式安装的系统库也不属于本清单。

## 本地命令

先按锁文件安装依赖，再执行：

```bash
cargo fetch --locked --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
pnpm supply-chain:check x86_64-pc-windows-msvc
pnpm supply-chain:generate artifacts/supply-chain/windows x86_64-pc-windows-msvc
```

示例 target 需替换为本次实际构建 target。`check` 在临时目录完成生成和验证后清理；`generate` 写入指定目录。
构建 Tauri 安装包时不需要手动生成，打包钩子会使用 `src-tauri/gen/supply-chain` 的受控临时目录。构建与收集
必须传同一 target，例如：

```bash
pnpm tauri build --ci --no-sign --target x86_64-pc-windows-msvc --bundles nsis
pnpm package:collect windows x86_64-pc-windows-msvc
```
