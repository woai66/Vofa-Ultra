# 供应链发布说明

Vofa-Ultra 为每个桌面目标生成独立的软件物料清单和第三方许可证材料。该流程的目标是让候选包中的依赖范围、
许可证选择和文件校验可审计；它不能替代代码签名、来源证明或法律审查。

## 输入与范围

生成器只读取仓库清单、锁定依赖图和包内元数据：

- 严格解析 `pnpm-lock.yaml` v9，从根 importer 的 `dependencies` 和 `optionalDependencies` 遍历
  `snapshots`；`node_modules` 只用于确认真实 optional 包及读取包自身元数据和法律文本。
- `cargo metadata --frozen --locked --filter-platform <target>` 提供当前 Rust 目标的正常依赖闭包。
- `package.json`、`tauri.conf.json` 和 `Cargo.toml` 的名称、版本及项目许可证必须一致。
- npm 开发依赖和 optional peer、Cargo `dev`/`build` 依赖及不适用于当前目标的 Cargo 分支不会进入
  运行时 SBOM。

CI 在生成前执行 `pnpm install --frozen-lockfile` 和目标级 `cargo fetch --locked --target <target>`。生成器不查询
许可证聚合网站，也不会用网络结果覆盖包自身声明。required 包、许可证元数据或冻结 Cargo 图缺失时直接失败；
未安装的真实 optional 包不会进入该目标的清单。

## 产物

当前目标会生成三份文件：

- `vofa-ultra-<target-triple>.cdx.json`：CycloneDX 1.6 JSON，包含 Package URL 和依赖边。
- `THIRD_PARTY_NOTICES-<target-triple>.txt`：组件、声明许可证、实际选择分支、上游地址及法律文本。
- `SUPPLY_CHAIN_SHA256SUMS`：前两份文件的 SHA-256。

SBOM 记录完整 Rust target，并绑定 `package.json`、`pnpm-lock.yaml`、`Cargo.toml`、`Cargo.lock` 和策略文件的
SHA-256。NOTICE 原文按内容 SHA-256 去重，同时记录精确 purl。扫描范围包括顶层 `LICENSE`/`LICENCE`、
`COPYING`、`NOTICE`、`COPYRIGHT`、`AUTHORS`、`PATENTS`、`UNLICENSE` 及 Cargo 声明的包内 `license_file`。

缺少许可证正文默认终止生成。正文必须在规范化后按许可证边界截取，并命中策略中已审核的完整条款 SHA-256；
关键句、截断文本、单独链接、SPDX 标识或 SPDX package metadata 均不算条款。例外只能精确到 purl 和版本，并引用
仓库内固定文本；来源 URL、文件 SHA-256、选择许可证和审核原因均由策略绑定。对 `OR` 表达式，生成器只会选择有
完整正文证据的允许分支；`AND` 的每个许可证及例外都必须有证据。升级依赖版本不会继承旧审核，正文指纹变化也会
要求重新审核。

Tauri 在 `beforeBuildCommand` 中生成这些文件，并把同一目录作为应用资源嵌入安装包。`package:collect` 随后验证
CycloneDX Schema、完整 target、项目元数据、输入摘要、精确 NOTICE inventory 和供应链校验值，再从该 target
专属 bundle 目录收集安装包，并把原文件与项目 `LICENSE` 放入同一个 `SHA256SUMS`。因此下载 sidecar 与安装
内容不会由两次独立扫描产生，也不会混入另一架构的旧 bundle。

版本标签的 `release-draft` job 只接受当前 run attempt 的 Linux、macOS、Windows 三个 artifact，重新验证各平台
清单、目标和项目许可证后再扁平化。重名的 `SUPPLY_CHAIN_SHA256SUMS` 会改为带 target 的名称，最终对全部 Release
assets 生成一个新的 `SHA256SUMS`。聚合清单还覆盖当前版本 CHANGELOG 和记录触发 commit、run ID/attempt、
target 与预发布通道的构建信息；远端标签会在 draft 创建前后解引用并与触发 commit 比对。该步骤只创建
draft，不替代签名、公证、安装或真实串口验收；完整规则见[发布流程](release-process.md)。

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

生成结果不含当前时间、随机 UUID 或绝对路径，组件、依赖边和文本使用稳定代码点排序。相同仓库输入、相同 target
及相同锁定包内容连续生成应逐字节一致；工具测试覆盖图遍历和排序，发布验证还需连续生成并比较三份文件。

这不代表完整安装包已经可复现。GitHub runner 镜像、系统包、平台 WebView 和签名环境仍会漂移；Windows
WebView2 Runtime 和 Linux 系统库也不属于 Node/Cargo 依赖图。正式 Release 必须另外记录 runner 镜像、精确
工具链、系统依赖、签名环境和最终包哈希，不能把本 SBOM 扩大解释为操作系统组件清单。

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
pnpm tauri build --ci --no-sign --target x86_64-pc-windows-msvc --bundles msi,nsis
pnpm package:collect windows x86_64-pc-windows-msvc
```
