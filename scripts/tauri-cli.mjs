#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENCODED_RUSTFLAGS_SEPARATOR = "\x1f";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const require_module = createRequire(import.meta.url);

export function split_cargo_rustflags(value) {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  return value
    .split(" ")
    .map((argument) => argument.trim())
    .filter((argument) => argument.length > 0);
}

function command_index(arguments_) {
  return arguments_.findIndex((argument) => argument !== "--" && !argument.startsWith("-"));
}

export function is_release_build(arguments_) {
  const index = command_index(arguments_);
  if (index < 0 || arguments_[index] !== "build") {
    return false;
  }
  const build_arguments = arguments_.slice(index + 1);
  const separator_index = build_arguments.indexOf("--");
  const build_options = separator_index < 0
    ? build_arguments
    : build_arguments.slice(0, separator_index);
  return !build_options.some((argument) => argument === "--debug" || argument === "-d");
}

export function default_cargo_home(environment, home_directory = homedir()) {
  if (typeof environment.CARGO_HOME === "string" && environment.CARGO_HOME.length > 0) {
    return environment.CARGO_HOME;
  }
  return path.join(home_directory, ".cargo");
}

export function resolved_path_variants(source_path, realpath_path = realpathSync.native) {
  const resolved = path.resolve(source_path);
  let canonical;
  try {
    canonical = path.resolve(realpath_path(resolved));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return [resolved];
    }
    throw error;
  }
  return canonical === resolved ? [resolved] : [resolved, canonical];
}

export function build_remap_path_flags({
  project_root,
  cargo_home,
  realpath_path = realpathSync.native,
}) {
  const mappings = [
    [project_root, "/workspace"],
    [cargo_home, "/cargo-home"],
  ];
  const flags = [];
  for (const [source_root, target_root] of mappings) {
    for (const source_path of resolved_path_variants(source_root, realpath_path)) {
      const flag = `--remap-path-prefix=${source_path}=${target_root}`;
      if (flag.includes(ENCODED_RUSTFLAGS_SEPARATOR)) {
        throw new Error("A release build path contains the encoded rustflags separator");
      }
      if (!flags.includes(flag)) {
        flags.push(flag);
      }
    }
  }
  return flags;
}

export function build_tauri_environment({
  arguments_,
  environment,
  project_root = PROJECT_ROOT,
  cargo_home = default_cargo_home(environment),
  realpath_path = realpathSync.native,
}) {
  const child_environment = { ...environment };
  if (!is_release_build(arguments_)) {
    return child_environment;
  }

  const inherited_flags = typeof environment.CARGO_ENCODED_RUSTFLAGS === "string"
    ? environment.CARGO_ENCODED_RUSTFLAGS
    : split_cargo_rustflags(environment.RUSTFLAGS).join(ENCODED_RUSTFLAGS_SEPARATOR);
  const remap_flags = build_remap_path_flags({ project_root, cargo_home, realpath_path });
  const encoded_remap_flags = remap_flags.join(ENCODED_RUSTFLAGS_SEPARATOR);
  child_environment.CARGO_ENCODED_RUSTFLAGS = inherited_flags.length > 0
    ? `${inherited_flags}${ENCODED_RUSTFLAGS_SEPARATOR}${encoded_remap_flags}`
    : encoded_remap_flags;
  delete child_environment.RUSTFLAGS;
  return child_environment;
}

export function resolve_tauri_cli_entry() {
  return require_module.resolve("@tauri-apps/cli/tauri.js");
}

export function run_tauri_cli({
  arguments_,
  environment,
  cli_entry = resolve_tauri_cli_entry(),
  spawn_process = spawn,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn_process(
      process.execPath,
      [cli_entry, ...arguments_],
      {
        env: environment,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const environment = build_tauri_environment({ arguments_, environment: process.env });
  const result = await run_tauri_cli({ arguments_, environment });
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

const is_main = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);
if (is_main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
