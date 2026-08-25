# 发布流程

本流程把 GitHub draft Release 视为候选包暂存区，而不是发布成功证明。自动化只负责从同一次 tag workflow 聚合、
复验和上传产物；签名、公证、安装与真实串口验证必须由发布者在 draft 阶段完成并留下证据。

## GitHub 仓库配置

首次推送标签前，维护者需要完成以下仓库设置：

1. 创建名为 `release-draft` 的 Environment，限制为 `v*` 标签，并配置至少一名 required reviewer。
2. 使用 ruleset 保护 `main` 和 `v*` 标签，禁止 force-push、删除已发布标签和绕过必需检查。主分支至少要求
   `Frontend and browser`、`Performance budget`、三平台 `Rust and desktop build` 与
   `Rust minimum supported version` 全部成功。
3. Actions 默认 `GITHUB_TOKEN` 权限保持只读。package job 仅增加 `id-token: write` 与 `attestations: write`；
   `release-draft` job 另外获得 `actions: read` 与 `contents: write`，用于下载同 run 产物并创建 draft。
4. 启用 Private vulnerability reporting；正式发布后建议启用 immutable releases。
5. 公布并验证私密行为报告渠道，更新[社区行为准则](../CODE_OF_CONDUCT.md)，且不能复用未启用或用途不符的
   安全漏洞入口。
6. 代码签名证书、公证凭据和私钥只能放在受保护 Environment，不能提供给 PR、普通 push 或无签名 package job。

Environment 尚未配置保护规则时，workflow 仍只会创建 draft，但这不满足正式发布要求。
GitHub 不支持按 step 缩小 job 权限，因此手动 `workflow_dispatch` 的 package job 也会获得 OIDC/attestation 权限，
但证明步骤仍按 `refs/tags/v` 条件跳过。手动触发权必须只授予仓库写权限成员；若开放给更广泛角色，应把手动无特权
打包与标签证明拆成独立 workflow。

## 准备版本

1. 从已 review 且 CI 通过的发布分支开始，确保工作区干净。
2. 同步 `package.json`、`src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 的版本。
3. 把 `CHANGELOG.md` 的待发布条目整理为唯一的 `## [<version>]` 章节，包含分类标题和至少一条变更；缺少该章节
   或 `Unreleased` 仍有内容会使本地与聚合校验失败。对照 `compatibility-policy.json` 和
   [兼容性与弃用政策](compatibility.md)，确认升级、弃用与迁移说明完整。
4. 执行仓库质量门禁：

```bash
pnpm check
pnpm benchmark
pnpm check:package
pnpm check:release
pnpm supply-chain:check
pnpm test:e2e
pnpm tauri build --ci --no-bundle
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

5. 对所有用户可见变化完成文档、迁移提示和截图 review，再创建带说明的版本标签：

```bash
git tag -a v0.1.0 -m "chore: prepare v0.1.0"
git push origin v0.1.0
```

标签必须严格等于 `v<package.json version>`。不要移动或复用已经产生 draft 的标签。

## 自动聚合

版本标签触发 `CI` workflow 后，三平台 package matrix 分别生成 Linux x64、Windows x64 和 macOS x64 候选包。
每个平台 artifact 都包含安装包、项目许可证、目标 CycloneDX、第三方 NOTICE、供应链清单、构建环境记录和平台
`SHA256SUMS`。环境记录只在 GitHub Actions 中生成，本地收集目录不能进入正式聚合。

`release-draft` job 只在三个 package 与独立 Linux 性能预算全部成功后运行，并执行以下 fail-closed 检查：

- 只接受当前 `github.run_number` 与 `github.run_attempt` 对应的三个平台目录，不接受旧尝试、缺失、额外或嵌套文件。
- 再次验证每个平台 `SHA256SUMS`，拒绝空文件、未列文件、重复名称、路径逃逸和内容篡改。
- 使用官方严格 Schema 重验 CycloneDX、目标 triple、输入摘要与 NOTICE inventory。
- 严格解析 canonical 环境 JSON，拒绝未知/乱序字段、路径泄漏、dirty 源码，以及错误版本、commit、平台或 target。
- 要求环境记录来自 GitHub hosted runner，并保留实际 runner image、Node/pnpm/Tauri CLI/Cargo/rustc/LLVM；Linux
  还必须包含 workflow 明确安装的四个系统包及版本。
- 要求三份项目 `LICENSE` 与标签源码逐字节一致，安装包文件名包含精确版本。
- 要求当前版本 CHANGELOG 章节非空，生成记录版本、触发 commit、run ID/attempt、target 和通道的构建信息。
- 保留目标专属供应链清单，并对扁平化后的全部 Release assets 重算单一 `SHA256SUMS`。
- draft 创建前后都通过 GitHub API 解引用 lightweight/annotated tag，并要求其 commit 与 workflow 源码一致。
- 已存在同标签 Release 时拒绝覆盖；v0.x 或带 SemVer 预发布后缀的 draft 自动标记为 prerelease。
- 三个平台在上传前分别对原始文件摘要生成 GitHub build provenance；聚合 job 在复验后对最终 Release assets
  再生成 provenance。两层 action 都固定到审核过的完整 commit SHA。

job 通过受保护的 `release-draft` Environment 创建 draft，不会调用 Publish，也不会把 draft 标记为 Latest。

可从独立下载目录验证某个文件的来源证明：

```bash
gh attestation verify <asset-file> --repo <owner>/Vofa-Ultra
```

平台证明对应实际执行 Tauri 构建的 matrix job；聚合证明对应 `release-draft` 对文件的复验、改名和补充材料。
证明只绑定 workflow/commit 与 SHA-256 摘要，不替代签名、公证、安装测试，也不表示 runner 镜像或系统包已固定。

## 人工放行

发布者必须把下列证据记录在 draft、受控测试记录或关联 Issue 中。没有证据的项目视为未完成。

| 门禁 | 最低证据 |
| --- | --- |
| Actions | tag workflow URL，所有必需 job 成功，构建信息、draft 正文、commit 与 tag 一致 |
| 完整性 | 在独立下载目录验证聚合 `SHA256SUMS`，记录命令和结果 |
| Windows | MSI 与 NSIS 各完成安装、启动、升级覆盖和卸载；记录系统版本 |
| macOS | DMG 完成安装、首次启动和卸载；正式版记录签名与 notarization 结果 |
| Linux | DEB 与 AppImage 各完成启动和卸载/清理；记录发行版、桌面与 WebKit 版本 |
| 串口芯片 | 关联硬件报告 Issue；至少两种 USB 串口芯片完成枚举、连接、双向收发、拔插和自动重连 |
| 控制线 | 在硬件报告中分别验证无流控、软件流控、硬件流控、DTR 与 RTS；记录设备和完整参数 |
| 数据链路 | FireWater、JustFloat、Raw、录制、回放、导出、处理图与姿态视图完成冒烟 |
| 安全与法律 | 核对 capability、CSP、SBOM、NOTICE、许可证选择和依赖变更 |
| 签名 | v1.0 稳定版的 Windows/macOS/Linux 发布策略均有可验证签名或明确平台说明 |
| 变更说明 | `CHANGELOG.md`、升级说明、已知问题和下载文件说明与候选包一致 |
| 兼容性 | 机器清单与实现一致；历史读取、未来版本保护、弃用周期和迁移说明均有测试或 review 证据 |

应用安装、真实串口和控制线操作必须由用户手动执行；自动化结果不能替代这些检查。
硬件记录必须符合[硬件兼容性证据规范](hardware-compatibility.md)，并使用
[硬件兼容性报告表单](../.github/ISSUE_TEMPLATE/hardware_report.yml)。发布者应在 draft 中引用报告 Issue，
逐项核对原始证据与未验证能力；只能记录 USB 唯一序列号是否存在，不能复制其值。

## 发布规则

- 未签名、未公证或未完成硬件验证的包只能保留为 draft，或在风险写明后发布为 v0.x prerelease。
- v1.0 及后续稳定版本必须完成全部人工门禁、签名和 macOS 公证，才能取消 prerelease 并 Publish。
- 发布者应确认 `SHA256SUMS`、目标 SBOM 和 NOTICE 与最终下载资产同时可见，再决定是否标记 Latest。
- 已发布版本发现安全或数据完整性问题时停止分发，按 `SECURITY.md` 协调修复和公告，不静默替换资产。

## 失败与重试

- 性能预算或任一 package 失败时不会创建 draft；如果源码、依赖或配置需要修改，必须使用新版本和新标签重新开始。
- 仅处理无源码变化的瞬态失败时，必须选择 **Re-run all jobs**，让三平台产物具有同一 `run_attempt`；只重跑失败
  job 会因混用旧 attempt 而被聚合器拒绝，不能跳过该门禁。
- 同标签 draft 已存在时 job 会拒绝覆盖。只有确认源码和资产未变化后，才可删除未发布 draft 并重跑。
- 标签在构建或审批期间移动会在 draft 创建前失败；若在创建窗口内移动，job 会失败并保留不可发布的 draft，
  发布者必须删除该 draft、恢复受保护标签并使用新版本重新开始。
- 源码、依赖、构建环境或产物发生变化时必须提升版本并创建新标签，禁止 force-move 原标签。
