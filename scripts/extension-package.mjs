#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import Ajv from "ajv";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(PROJECT_ROOT, "schemas", "extension-v1.schema.json");
const EXTENSION_FORMAT = "vofa-ultra-extension";
const EXTENSION_SCHEMA_VERSION = 1;
const MAX_MANIFEST_SOURCE_BYTES = 64 * 1024;
export const MAX_EXTENSION_PACKAGE_BYTES = 1536 * 1024;
export const MAX_EXTENSION_MODULE_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true });
const validate_schema = ajv.compile(schema);

function fail(message) {
  throw new Error(message);
}

function sha256_hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decode_utf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function schema_error_message() {
  return ajv.errorsText(validate_schema.errors, { dataVar: "extension package", separator: "; " });
}

function validate_display_text(label, value, max_characters, max_bytes, allow_empty) {
  if (value.trim() !== value || (!allow_empty && value.length === 0)) {
    fail(`${label} must not be empty or contain surrounding whitespace`);
  }
  if ([...value].length > max_characters || Buffer.byteLength(value, "utf8") > max_bytes) {
    fail(`${label} exceeds its character or UTF-8 byte limit`);
  }
  if ([...value].some(is_forbidden_display_character)) {
    fail(`${label} contains a control, bidi, or invisible formatting character`);
  }
}

function is_forbidden_display_character(character) {
  const code_point = character.codePointAt(0);
  if (code_point === undefined) {
    return true;
  }
  if (code_point <= 0x1f || (code_point >= 0x7f && code_point <= 0x9f)) {
    return true;
  }
  if (code_point >= 0xd800 && code_point <= 0xdfff) {
    return true;
  }
  if (character !== " " && /\p{White_Space}/u.test(character)) {
    return true;
  }
  return code_point === 0x00ad
    || code_point === 0x034f
    || code_point === 0x061c
    || code_point === 0x180e
    || (code_point >= 0x200b && code_point <= 0x200f)
    || (code_point >= 0x202a && code_point <= 0x202e)
    || (code_point >= 0x2060 && code_point <= 0x206f)
    || code_point === 0xfeff
    || (code_point >= 0xfff9 && code_point <= 0xfffb)
    || code_point === 0xe0001
    || (code_point >= 0xe0020 && code_point <= 0xe007f);
}

function validate_manifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("Extension manifest must be a JSON object");
  }
  if (
    !manifest.version
    || ![...manifest.version].every((character) => character.codePointAt(0) <= 0x7f)
  ) {
    fail("Extension version must be non-empty ASCII SemVer");
  }
  const maximum_u64 = 18_446_744_073_709_551_615n;
  const core_version = manifest.version.split(/[+-]/u, 1)[0];
  if (core_version.split(".").some((identifier) => BigInt(identifier) > maximum_u64)) {
    fail("Extension SemVer major, minor, and patch identifiers must fit in u64");
  }
  validate_display_text("Extension name", manifest.name, 64, 256, false);
  validate_display_text("Extension description", manifest.description, 256, 1024, true);
  if (
    manifest.license.trim() !== manifest.license
    || Buffer.byteLength(manifest.license, "ascii") > 128
  ) {
    fail("Extension license declaration is empty, padded, or exceeds 128 ASCII bytes");
  }
}

function validate_wasm_module(module_bytes) {
  if (module_bytes.length === 0 || module_bytes.length > MAX_EXTENSION_MODULE_BYTES) {
    fail(`Wasm module must contain 1 to ${MAX_EXTENSION_MODULE_BYTES} bytes`);
  }
  const wasm_header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  if (module_bytes.length < wasm_header.length || !module_bytes.subarray(0, 8).equals(wasm_header)) {
    fail("Module does not start with the WebAssembly v1 header");
  }
}

function decode_module_base64(value) {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    fail("moduleBase64 is not canonical RFC 4648 Base64");
  }
  return decoded;
}

function validate_package_value(package_value) {
  if (!validate_schema(package_value)) {
    fail(`Extension package does not match schema v1: ${schema_error_message()}`);
  }
  validate_manifest(package_value.manifest);
  const module_bytes = decode_module_base64(package_value.moduleBase64);
  validate_wasm_module(module_bytes);
  if (sha256_hex(module_bytes) !== package_value.moduleSha256) {
    fail("Wasm module SHA-256 does not match moduleSha256");
  }
  return module_bytes;
}

export function canonical_extension_package(package_value) {
  return {
    format: package_value.format,
    schemaVersion: package_value.schemaVersion,
    manifest: {
      id: package_value.manifest.id,
      version: package_value.manifest.version,
      name: package_value.manifest.name,
      description: package_value.manifest.description,
      license: package_value.manifest.license,
      apiVersion: package_value.manifest.apiVersion,
      kind: package_value.manifest.kind,
      capabilities: [...package_value.manifest.capabilities],
    },
    moduleSha256: package_value.moduleSha256,
    moduleBase64: package_value.moduleBase64,
  };
}

export function serialize_extension_package(package_value) {
  validate_package_value(package_value);
  return `${JSON.stringify(canonical_extension_package(package_value), null, 2)}\n`;
}

async function read_bounded_file(file_path, maximum_bytes, label) {
  const metadata = await stat(file_path);
  if (!metadata.isFile()) {
    fail(`${label} is not a regular file`);
  }
  if (metadata.size === 0 || metadata.size > maximum_bytes) {
    fail(`${label} must contain 1 to ${maximum_bytes} bytes`);
  }
  const bytes = await readFile(file_path);
  if (bytes.length === 0 || bytes.length > maximum_bytes) {
    fail(`${label} changed while being read or exceeds its byte limit`);
  }
  return bytes;
}

export async function pack_extension_package({ manifest_path, module_path, output_path }) {
  if (path.extname(output_path).toLowerCase() !== ".vux") {
    fail("Extension package output must use the .vux suffix");
  }
  const manifest_bytes = await read_bounded_file(
    manifest_path,
    MAX_MANIFEST_SOURCE_BYTES,
    "Extension manifest",
  );
  let manifest;
  try {
    manifest = JSON.parse(decode_utf8(manifest_bytes, "Extension manifest"));
  } catch (error) {
    fail(`Extension manifest is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  const module_bytes = await read_bounded_file(
    module_path,
    MAX_EXTENSION_MODULE_BYTES,
    "Wasm module",
  );
  validate_wasm_module(module_bytes);
  const package_value = {
    format: EXTENSION_FORMAT,
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    manifest,
    moduleSha256: sha256_hex(module_bytes),
    moduleBase64: module_bytes.toString("base64"),
  };
  const serialized = serialize_extension_package(package_value);
  const package_bytes = Buffer.from(serialized, "utf8");
  if (package_bytes.length > MAX_EXTENSION_PACKAGE_BYTES) {
    fail(`Extension package exceeds ${MAX_EXTENSION_PACKAGE_BYTES} bytes`);
  }
  await mkdir(path.dirname(path.resolve(output_path)), { recursive: true });
  await writeFile(output_path, package_bytes);
  return {
    manifest: canonical_extension_package(package_value).manifest,
    module_sha256: package_value.moduleSha256,
    package_sha256: sha256_hex(package_bytes),
    package_bytes: package_bytes.length,
    module_bytes: module_bytes.length,
    output_path: path.resolve(output_path),
  };
}

export async function verify_extension_package(package_path, expected_module_path) {
  if (path.extname(package_path).toLowerCase() !== ".vux") {
    fail("Extension package input must use the .vux suffix");
  }
  const package_bytes = await read_bounded_file(
    package_path,
    MAX_EXTENSION_PACKAGE_BYTES,
    "Extension package",
  );
  let package_value;
  try {
    package_value = JSON.parse(decode_utf8(package_bytes, "Extension package"));
  } catch (error) {
    fail(`Extension package is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  const module_bytes = validate_package_value(package_value);
  const canonical_bytes = Buffer.from(serialize_extension_package(package_value), "utf8");
  if (!package_bytes.equals(canonical_bytes)) {
    fail("Extension package is not canonical JSON produced by the v1 packer");
  }
  if (expected_module_path) {
    const expected_module = await read_bounded_file(
      expected_module_path,
      MAX_EXTENSION_MODULE_BYTES,
      "Expected Wasm module",
    );
    if (!module_bytes.equals(expected_module)) {
      fail("Embedded Wasm module does not match the expected module file");
    }
  }
  return {
    manifest: canonical_extension_package(package_value).manifest,
    module_sha256: package_value.moduleSha256,
    package_sha256: sha256_hex(package_bytes),
    package_bytes: package_bytes.length,
    module_bytes: module_bytes.length,
    package_path: path.resolve(package_path),
  };
}

async function main() {
  const [command, first_argument, second_argument, third_argument] = process.argv.slice(2);
  let result;
  if (command === "pack" && first_argument && second_argument && third_argument) {
    result = await pack_extension_package({
      manifest_path: first_argument,
      module_path: second_argument,
      output_path: third_argument,
    });
    console.log(
      `Packed ${result.manifest.id}@${result.manifest.version} to ${result.output_path}`,
    );
  } else if (command === "verify" && first_argument && !third_argument) {
    result = await verify_extension_package(first_argument, second_argument);
    console.log(
      `Verified ${result.manifest.id}@${result.manifest.version} (${result.package_sha256})`,
    );
  } else {
    fail(
      "Usage: extension-package.mjs pack <manifest.json> <module.wasm> <output.vux> "
        + "| verify <package.vux> [expected-module.wasm]",
    );
  }
}

const is_main = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (is_main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
