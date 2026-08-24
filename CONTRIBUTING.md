# 贡献指南

感谢你改进 Vofa-Ultra。首要原则是保持基础串口路径可靠、改动边界清晰，并让行为可以在没有硬件时复现。

## 开始之前

- 缺陷和功能建议先搜索现有 Issue。
- 大型功能、协议 API 或数据格式变更，请先提交设计讨论。
- 安全问题不要公开披露，按 [安全策略](SECURITY.md) 报告。
- 提交的代码必须是原创或许可证兼容，并在 PR 中说明第三方来源。

## 开发环境

需要 Node.js 22、pnpm 11。桌面端还需要 Rust 1.88.0 或更高版本，以及
[Tauri 2 平台依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install
pnpm dev
```

浏览器预览只使用模拟器。访问真实串口：

```bash
pnpm tauri dev
```

桌面应用应提交 `src-tauri/Cargo.lock`，不要删除或忽略它。

## 分支与提交

从最新 `main` 或 `master` 创建单一职责分支：

- `feat/<name>`
- `fix/<name>`
- `docs/<name>`
- `refactor/<name>`
- `test/<name>`
- `chore/<name>`

提交信息使用简化 Conventional Commits：

```text
feat: add capture replay
fix: preserve state after device removal
docs: document protocol limits
```

一个提交只处理一件事，不在功能提交中混入无关格式化或重构。

## 修改要求

- TypeScript 保持严格类型，不用 `any` 绕过边界。
- Rust 代码通过 `rustfmt`；错误必须保留足够的用户行动信息。
- 串口字节、日志、通道和任务队列必须有明确上限。
- 中断采集、发送队列满、设备拔出和组件卸载都要有清晰退出路径。
- 新协议遵循[内置协议贡献契约](docs/protocols.md)，支持任意分包，并覆盖跨 chunk 帧尾、损坏帧和超长输入。
- UI 变更同时检查 1440 x 900 和 390 x 844，不产生页面级横向溢出。
- 不扩大 Tauri capability 或 CSP，除非 PR 解释需求、威胁面和替代方案。
- 新增依赖必须通过 `supply-chain-policy.json`；许可证表达式、正文指纹、包内 notices 或 target 闭包变化需重点 review。
- 代码、协议夹具、图标、截图和其他资产若来自第三方，PR 必须记录原始 URL、版本/commit、许可证及修改内容。
- 不接受来源不明的复制内容；修改 MPL-2.0 覆盖文件时必须保存对应源码获取方式和补丁。

## 验证

提交 PR 前运行：

```bash
pnpm check
pnpm benchmark
pnpm check:package
pnpm supply-chain:check
pnpm test:e2e
pnpm tauri build --ci --no-bundle
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

涉及真实串口时，还需记录操作系统、适配器芯片、参数、测试时长，以及连接、收发、拔插和重连结果。烧录和
硬件操作由测试者手动完成。

涉及协议解析、环形缓冲、处理图、Store 摄入或回放批处理的改动必须运行 `pnpm benchmark`，并在 PR 中记录
`artifacts/performance/summary.md` 的结果。Linux CI 结果是绝对预算的权威依据；放宽
`performance-budgets.json` 时必须附同一环境至少五轮数据、业务吞吐依据和独立 review，不能与性能退化修复混在
同一项无说明提交中。完整方法见[性能基准](docs/performance.md)。

## 候选安装包

普通 push 和 PR 只验证三平台最终桌面二进制，不生成安装包。需要检查打包链路时，手动运行 `CI` workflow；
与 `package.json`、`tauri.conf.json` 和 `Cargo.toml` 版本一致的 `v*` 标签也会触发打包。手动 workflow 只上传
无签名 MSI、NSIS、DMG、DEB、AppImage、平台 CycloneDX、第三方 notices、项目许可证及逐文件 SHA-256。标签
workflow 会在三平台全部成功后重新验证并聚合这些文件，通过 `release-draft` Environment 创建 draft Release；
聚合资产还包含版本 CHANGELOG 与 source/run 绑定记录，并在创建前后验证远端标签 commit。v0.x 和 SemVer
预发布版本会标记为 prerelease；自动化不会 Publish 或标记 Latest。完整门禁见[发布流程](docs/release-process.md)。

版本标签、draft 审批、正式发布、签名和公证属于发布者操作。候选包生成成功不能替代目标系统上的安装、启动、
卸载和串口硬件冒烟记录。AppImage 从 Actions artifact 下载后可能需要重新添加可执行权限。

## Pull Request

PR 正文至少包含：

- 改动：解决什么问题，行为如何变化。
- 验证情况：执行了哪些自动和手动检查。
- 重点 review：并发、兼容性、安全或迁移风险。
- 截图：仅 UI 行为或布局发生变化时需要。

CI 通过不等于可以合并。涉及串口生命周期、记录格式、权限或发布流程的改动需要额外人工 review。
