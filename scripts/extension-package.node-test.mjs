import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import {
  pack_extension_package,
  serialize_extension_package,
  verify_extension_package,
} from "./extension-package.mjs";

const EMPTY_WASM_MODULE = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function manifest(overrides = {}) {
  return {
    id: "io.vofa.example-parser",
    version: "1.2.3",
    name: "Example parser",
    description: "Deterministic tooling fixture",
    license: "MIT",
    apiVersion: 1,
    kind: "protocol-parser",
    capabilities: ["live-rx.read"],
    ...overrides,
  };
}

async function with_fixture(operation) {
  const directory = await mkdtemp(path.join(tmpdir(), "vofa-ultra-extension-"));
  try {
    const manifest_path = path.join(directory, "manifest.json");
    const module_path = path.join(directory, "parser.wasm");
    await writeFile(manifest_path, `${JSON.stringify(manifest(), null, 2)}\n`, "utf8");
    await writeFile(module_path, EMPTY_WASM_MODULE);
    await operation({ directory, manifest_path, module_path });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("packs deterministic canonical .vux files and verifies the source module", async () => {
  await with_fixture(async ({ directory, manifest_path, module_path }) => {
    const first_path = path.join(directory, "first.vux");
    const second_path = path.join(directory, "second.vux");
    const first = await pack_extension_package({ manifest_path, module_path, output_path: first_path });
    const second = await pack_extension_package({ manifest_path, module_path, output_path: second_path });
    const first_bytes = await readFile(first_path);
    const second_bytes = await readFile(second_path);

    assert.deepEqual(first_bytes, second_bytes);
    assert.equal(first.package_sha256, second.package_sha256);
    assert.equal(first_bytes.at(-1), 0x0a);
    assert.equal(first_bytes.includes(0x0d), false);
    assert.equal(first_bytes.toString("utf8").startsWith('{\n  "format"'), true);

    const verified = await verify_extension_package(first_path, module_path);
    assert.equal(verified.package_sha256, first.package_sha256);
    assert.equal(verified.module_sha256, first.module_sha256);
    assert.equal(verified.manifest.id, manifest().id);

    const renamed_path = path.join(directory, "renamed.json");
    await writeFile(renamed_path, first_bytes);
    await assert.rejects(
      verify_extension_package(renamed_path),
      /input must use the \.vux suffix/,
    );
  });
});

test("rejects schema drift, forbidden display text, and non-Wasm input", async () => {
  const base_package = {
    format: "vofa-ultra-extension",
    schemaVersion: 1,
    manifest: manifest(),
    moduleSha256: "93a44bbb96c751218e4c00d47937f9b7b6e2f7d9f73f98d3018b8b4db60f2a11",
    moduleBase64: EMPTY_WASM_MODULE.toString("base64"),
  };
  assert.throws(
    () => serialize_extension_package({ ...base_package, extra: true }),
    /does not match schema v1/,
  );
  assert.throws(
    () => serialize_extension_package({
      ...base_package,
      manifest: manifest({ name: "trusted\u202espoof" }),
    }),
    /control, bidi, or invisible/,
  );
  assert.throws(
    () => serialize_extension_package({
      ...base_package,
      manifest: manifest({ name: "invalid\ud800" }),
    }),
    /control, bidi, or invisible/,
  );
  assert.throws(
    () => serialize_extension_package({
      ...base_package,
      manifest: manifest({ version: "18446744073709551616.0.0" }),
    }),
    /must fit in u64/,
  );
  assert.throws(
    () => serialize_extension_package({
      ...base_package,
      manifest: manifest({ license: "   " }),
    }),
    /does not match schema v1/,
  );

  await with_fixture(async ({ directory, manifest_path }) => {
    const invalid_module_path = path.join(directory, "invalid.wasm");
    await writeFile(invalid_module_path, Buffer.from("not wasm", "utf8"));
    await assert.rejects(
      pack_extension_package({
        manifest_path,
        module_path: invalid_module_path,
        output_path: path.join(directory, "invalid.vux"),
      }),
      /WebAssembly v1 header/,
    );
  });
});

test("rejects invalid UTF-8 instead of replacing manifest or package bytes", async () => {
  await with_fixture(async ({ directory, manifest_path, module_path }) => {
    const invalid_manifest = Buffer.from(`${JSON.stringify(manifest({ name: "Invalid byte" }))}\n`);
    invalid_manifest[invalid_manifest.indexOf("Invalid byte") + "Invalid ".length] = 0xff;
    await writeFile(manifest_path, invalid_manifest);
    await assert.rejects(
      pack_extension_package({
        manifest_path,
        module_path,
        output_path: path.join(directory, "invalid-manifest.vux"),
      }),
      /manifest is not valid UTF-8/,
    );

    await writeFile(manifest_path, `${JSON.stringify(manifest(), null, 2)}\n`, "utf8");
    const package_path = path.join(directory, "invalid-package.vux");
    await pack_extension_package({ manifest_path, module_path, output_path: package_path });
    const invalid_package = await readFile(package_path);
    invalid_package[invalid_package.indexOf("Example parser") + "Example ".length] = 0xff;
    await writeFile(package_path, invalid_package);
    await assert.rejects(verify_extension_package(package_path), /package is not valid UTF-8/);
  });
});

test("rejects tampered, non-canonical, and unexpected embedded modules", async () => {
  await with_fixture(async ({ directory, manifest_path, module_path }) => {
    const package_path = path.join(directory, "parser.vux");
    await pack_extension_package({ manifest_path, module_path, output_path: package_path });
    const canonical = await readFile(package_path, "utf8");
    const package_value = JSON.parse(canonical);
    const original_module_sha256 = package_value.moduleSha256;

    package_value.moduleSha256 = "0".repeat(64);
    await writeFile(package_path, `${JSON.stringify(package_value, null, 2)}\n`, "utf8");
    await assert.rejects(verify_extension_package(package_path), /SHA-256 does not match/);

    package_value.moduleSha256 = original_module_sha256;
    await writeFile(package_path, JSON.stringify(package_value), "utf8");
    await assert.rejects(verify_extension_package(package_path), /not canonical JSON/);

    await writeFile(package_path, canonical, "utf8");
    const different_module_path = path.join(directory, "different.wasm");
    await writeFile(
      different_module_path,
      Buffer.concat([EMPTY_WASM_MODULE, Buffer.from([0x00])]),
    );
    await assert.rejects(
      verify_extension_package(package_path, different_module_path),
      /does not match the expected module/,
    );
  });
});
