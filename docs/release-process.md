# 发布流程

项目当前不启用 GitHub Actions。push、PR 和版本标签不会自动测试、打包或创建 Release；Dependabot 只负责依赖
更新提醒。维护者先在本地完成检查，再人工整理候选包。等项目和维护流程稳定后，再单独评估是否需要最小化自动化。

## 1. 准备版本

1. 从已 review 的干净分支开始。
2. 同步 `package.json`、`src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 的版本。
3. 整理 `CHANGELOG.md`，确保当前版本有明确的新增、修复和已知问题。
4. 确认锁文件、用户文档和兼容性说明与代码一致。

## 2. 本地检查

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm benchmark
pnpm check:package
pnpm check:release
pnpm test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

涉及真实串口、控制线或安装包的检查必须人工执行。本地自动测试不能替代设备连接、双向收发、拔插、重连和
目标系统安装验证。

## 3. 构建候选包

首个 Beta 只在 Windows 10/11 x64 构建一个无签名 NSIS `.exe` 候选包。具体命令见
[README](../README.md#本地无签名-windows-候选包)。

构建后至少确认：

- 安装包能安装、启动和卸载。
- 模拟数据、真实串口、录制、回放和导出能完成基本冒烟。
- `SHA256SUMS`、SBOM、第三方许可证材料和实际文件一致。
- 候选包未经代码签名，必须明确标记为 Windows Beta 测试包，不作为稳定版本发布。

## 4. 创建 GitHub 草稿 Release

1. 创建与项目版本一致的 annotated tag，例如 `v0.1.0-beta.1`。
2. 在 GitHub 手动创建 Draft Prerelease。
3. 只上传已人工验证的 Windows x64 `.exe`；SHA-256 写入 Release 正文，供应链与许可证材料留作本地复验记录。
4. 在草稿中记录测试系统、串口硬件、已完成检查和已知限制。

未完成 Windows 安装/启动/卸载、真实硬件和核心工作流验证时，只保留草稿，不发布 Beta；首个 Beta 未签名，
必须始终标记为预发布版本。
