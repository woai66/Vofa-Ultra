> [!WARNING]
> This draft contains unsigned, non-notarized candidate packages. Do not publish it as a stable release until the
> platform smoke tests, hardware checks, signing, and macOS notarization gates in `docs/release-process.md` are
> complete.

These candidate packages were built and collected manually on their target platforms. Before publishing, verify every
file against `SHA256SUMS`, record the source commit and toolchain used for each platform, and confirm that the versioned
changelog matches the packages. Manual checks do not replace code signing, notarization, installation tests, or real
serial hardware validation.
