import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ENCODED_RUSTFLAGS_SEPARATOR,
  build_remap_path_flags,
  build_tauri_environment,
  is_release_build,
  resolved_path_variants,
  run_tauri_cli,
  split_cargo_rustflags,
} from "./tauri-cli.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_WITH_SPACES = path.join(path.parse(PROJECT_ROOT).root, "release workspace", "vofa ultra");
const CARGO_HOME_WITH_SPACES = path.join(path.parse(PROJECT_ROOT).root, "cargo cache", ".cargo");

function unchanged_realpath(source_path) {
  return source_path;
}

function encoded_arguments(environment) {
  return environment.CARGO_ENCODED_RUSTFLAGS.split(ENCODED_RUSTFLAGS_SEPARATOR);
}

function release_environment(environment = {}, overrides = {}) {
  return build_tauri_environment({
    arguments_: ["build"],
    environment,
    project_root: PROJECT_WITH_SPACES,
    cargo_home: CARGO_HOME_WITH_SPACES,
    realpath_path: unchanged_realpath,
    ...overrides,
  });
}

test("routes only non-debug Tauri build commands through release remapping", () => {
  assert.equal(is_release_build(["build"]), true);
  assert.equal(is_release_build(["--verbose", "build", "--target", "x86_64-pc-windows-msvc"]), true);
  assert.equal(is_release_build(["build", "--", "--debug"]), true);
  assert.equal(is_release_build(["build", "--debug"]), false);
  assert.equal(is_release_build(["build", "-d"]), false);
  assert.equal(is_release_build(["dev"]), false);
  assert.equal(is_release_build(["bundle"]), false);
});

test("encodes release remaps without inheriting a HOME-wide mapping", () => {
  const home_directory = path.join(path.parse(PROJECT_ROOT).root, "private home");
  const result = release_environment({ HOME: home_directory, KEEP_ME: "yes" });
  const arguments_ = encoded_arguments(result);
  assert.deepEqual(arguments_, [
    `--remap-path-prefix=${path.resolve(PROJECT_WITH_SPACES)}=/workspace`,
    `--remap-path-prefix=${path.resolve(CARGO_HOME_WITH_SPACES)}=/cargo-home`,
  ]);
  assert.equal(arguments_.includes(`--remap-path-prefix=${path.resolve(home_directory)}=/workspace`), false);
  assert.equal(result.KEEP_ME, "yes");
  assert.equal(Object.hasOwn(result, "RUSTFLAGS"), false);
});

test("converts legacy RUSTFLAGS with Cargo's literal-space semantics", () => {
  const result = release_environment({
    RUSTFLAGS: '--cfg "feature flag"  -Cdebuginfo=0',
  });
  assert.deepEqual(encoded_arguments(result).slice(0, 4), [
    "--cfg",
    '"feature',
    'flag"',
    "-Cdebuginfo=0",
  ]);
  assert.deepEqual(
    split_cargo_rustflags("  --cfg\tfeature  -C opt-level=2  "),
    ["--cfg\tfeature", "-C", "opt-level=2"],
  );
  assert.equal(Object.hasOwn(result, "RUSTFLAGS"), false);
});

test("preserves encoded flags and gives them precedence over RUSTFLAGS", () => {
  const encoded = ["--cfg", "encoded feature"].join(ENCODED_RUSTFLAGS_SEPARATOR);
  const encoded_only = release_environment({ CARGO_ENCODED_RUSTFLAGS: encoded });
  assert.deepEqual(encoded_arguments(encoded_only).slice(0, 2), ["--cfg", "encoded feature"]);

  const both = release_environment({
    CARGO_ENCODED_RUSTFLAGS: encoded,
    RUSTFLAGS: "--cfg legacy_feature",
  });
  assert.deepEqual(encoded_arguments(both).slice(0, 2), ["--cfg", "encoded feature"]);
  assert.equal(both.CARGO_ENCODED_RUSTFLAGS.includes("legacy_feature"), false);
  assert.equal(Object.hasOwn(both, "RUSTFLAGS"), false);
});

test("keeps source paths containing spaces in individual encoded arguments", () => {
  const arguments_ = encoded_arguments(release_environment());
  assert.equal(arguments_.length, 2);
  assert.equal(arguments_[0].includes(PROJECT_WITH_SPACES), true);
  assert.equal(arguments_[1].includes(CARGO_HOME_WITH_SPACES), true);
});

test("does not change dev or debug environments", () => {
  const environment = {
    CARGO_ENCODED_RUSTFLAGS: "--cfg\x1fencoded",
    RUSTFLAGS: "--cfg legacy",
  };
  for (const arguments_ of [["dev"], ["build", "--debug"], ["build", "-d"]]) {
    const result = build_tauri_environment({ arguments_, environment });
    assert.deepEqual(result, environment);
    assert.notEqual(result, environment);
  }
});

test("deduplicates equal realpaths and includes distinct realpaths in stable order", () => {
  assert.deepEqual(
    resolved_path_variants(PROJECT_WITH_SPACES, unchanged_realpath),
    [path.resolve(PROJECT_WITH_SPACES)],
  );

  const project_resolved = path.resolve(PROJECT_WITH_SPACES);
  const cargo_resolved = path.resolve(CARGO_HOME_WITH_SPACES);
  const project_realpath = path.join(path.parse(PROJECT_ROOT).root, "canonical", "workspace");
  const cargo_realpath = path.join(path.parse(PROJECT_ROOT).root, "canonical", "cargo-home");
  const realpaths = new Map([
    [project_resolved, project_realpath],
    [cargo_resolved, cargo_realpath],
  ]);
  assert.deepEqual(
    build_remap_path_flags({
      project_root: PROJECT_WITH_SPACES,
      cargo_home: CARGO_HOME_WITH_SPACES,
      realpath_path: (source_path) => realpaths.get(source_path),
    }),
    [
      `--remap-path-prefix=${project_resolved}=/workspace`,
      `--remap-path-prefix=${path.resolve(project_realpath)}=/workspace`,
      `--remap-path-prefix=${cargo_resolved}=/cargo-home`,
      `--remap-path-prefix=${path.resolve(cargo_realpath)}=/cargo-home`,
    ],
  );
});

test("package script invokes the project wrapper", () => {
  const package_manifest = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  assert.equal(package_manifest.scripts.tauri, "node scripts/tauri-cli.mjs");
});

test("forwards every CLI argument and returns the child exit result", async () => {
  const child = new EventEmitter();
  let invocation;
  const result_promise = run_tauri_cli({
    arguments_: ["build", "--target", "x86_64-pc-windows-msvc", "--", "--runner-value"],
    environment: { FIXTURE: "yes" },
    cli_entry: path.join(PROJECT_ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js"),
    spawn_process: (command, arguments_, options) => {
      invocation = { command, arguments_, options };
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return child;
    },
  });

  assert.deepEqual(invocation.arguments_.slice(1), [
    "build",
    "--target",
    "x86_64-pc-windows-msvc",
    "--",
    "--runner-value",
  ]);
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.options.env, { FIXTURE: "yes" });
  assert.equal(invocation.options.stdio, "inherit");
  assert.deepEqual(await result_promise, { code: null, signal: "SIGTERM" });
});
