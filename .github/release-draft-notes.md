> [!WARNING]
> This draft contains unsigned, non-notarized candidate packages. Do not publish it as a stable release until the
> platform smoke tests, hardware checks, signing, and macOS notarization gates in `docs/release-process.md` are
> complete.

The workflow reverified all three current-run artifacts, their target-specific CycloneDX and NOTICE files, the
repository license, the versioned changelog, and the source/run binding metadata before producing the aggregate
`SHA256SUMS`. It also checked the remote tag against the triggering commit before and after draft creation. A draft is
never evidence that installation or real serial hardware behavior passed.
