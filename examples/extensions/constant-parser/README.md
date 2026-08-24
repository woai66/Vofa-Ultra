# Constant parser extension

This is the smallest repository-verified `vux-wasm-v1` protocol parser. Every accepted RX batch emits one frame
with a single `example` channel whose value is `1`.

Build and package it with WABT and the repository packer:

```sh
wat2wasm examples/extensions/constant-parser/parser.wat \
  -o examples/extensions/constant-parser/parser.wasm
pnpm extension:pack -- examples/extensions/constant-parser/manifest.json \
  examples/extensions/constant-parser/parser.wasm constant-parser.vux
pnpm extension:verify -- constant-parser.vux examples/extensions/constant-parser/parser.wasm
```

The package is intentionally unsigned. SHA-256 binds the inspected package and embedded module bytes; it does not
authenticate the author. Only load extensions whose source and build provenance you have reviewed.
