#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = path.join(PROJECT_ROOT, "package.json");
const TAURI_CONFIG_PATH = path.join(PROJECT_ROOT, "src-tauri", "tauri.conf.json");
const CARGO_MANIFEST_PATH = path.join(PROJECT_ROOT, "src-tauri", "Cargo.toml");
const LICENSE_PATH = path.join(PROJECT_ROOT, "LICENSE");
const TAURI_CLI_PACKAGE_PATH = path.join(
  PROJECT_ROOT,
  "node_modules",
  "@tauri-apps",
  "cli",
  "package.json",
);
const BUNDLE_SUPPLY_CHAIN_ROOT = path.join(
  PROJECT_ROOT,
  "src-tauri",
  "gen",
  "supply-chain",
);
const DEFAULT_BUNDLE_ROOT = path.join(PROJECT_ROOT, "src-tauri", "target", "release", "bundle");
const BUILD_ENVIRONMENT_PREFIX = "BUILD_ENVIRONMENT";
export const BUILD_ENVIRONMENT_MAX_BYTES = 32 * 1024;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RUST_TARGET_PATTERN = /^[a-z0-9_.-]+$/;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export const PROJECT_RELEASE_COORDINATES = Object.freeze({
  npm_repository: "https://github.com/woai66/Vofa-Ultra.git",
  homepage: "https://github.com/woai66/Vofa-Ultra#readme",
  issues: "https://github.com/woai66/Vofa-Ultra/issues",
  cargo_repository: "https://github.com/woai66/Vofa-Ultra",
  cargo_homepage: "https://github.com/woai66/Vofa-Ultra",
  tauri_identifier: "io.github.woai66.vofaultra",
});

export const BUILD_PLATFORMS = Object.freeze({
  linux: Object.freeze({
    runner_hosts: Object.freeze({ X64: "x86_64-unknown-linux-gnu" }),
    runner_os: "Linux",
    target_triple: "x86_64-unknown-linux-gnu",
  }),
  macos: Object.freeze({
    runner_hosts: Object.freeze({
      ARM64: "aarch64-apple-darwin",
      X64: "x86_64-apple-darwin",
    }),
    runner_os: "macOS",
    target_triple: "x86_64-apple-darwin",
  }),
  windows: Object.freeze({
    runner_hosts: Object.freeze({ X64: "x86_64-pc-windows-msvc" }),
    runner_os: "Windows",
    target_triple: "x86_64-pc-windows-msvc",
  }),
});

export const LINUX_BUILD_PACKAGES = Object.freeze([
  "libayatana-appindicator3-dev",
  "librsvg2-dev",
  "libwebkit2gtk-4.1-dev",
  "patchelf",
]);

const PLATFORM_ARTIFACTS = {
  linux: [
    {
      label: "Debian package",
      matches: (file_path, bundle_root) =>
        has_parent(bundle_root, file_path, "deb")
          && file_path.toLowerCase().endsWith(".deb"),
    },
    {
      label: "AppImage",
      matches: (file_path, bundle_root) =>
        has_parent(bundle_root, file_path, "appimage") && file_path.endsWith(".AppImage"),
    },
  ],
  macos: [
    {
      label: "macOS disk image",
      matches: (file_path, bundle_root) =>
        has_parent(bundle_root, file_path, "dmg")
          && file_path.toLowerCase().endsWith(".dmg"),
    },
  ],
  windows: [
    {
      label: "Windows Installer package",
      matches: (file_path, bundle_root) =>
        has_parent(bundle_root, file_path, "msi")
          && file_path.toLowerCase().endsWith(".msi"),
    },
    {
      label: "NSIS installer",
      matches: (file_path, bundle_root) =>
        has_parent(bundle_root, file_path, "nsis")
          && file_path.toLowerCase().endsWith(".exe"),
    },
  ],
};

function fail(message) {
  throw new Error(message);
}

export function has_parent(bundle_root, file_path, directory_name) {
  const relative_path = path.relative(bundle_root, file_path);
  if (path.isAbsolute(relative_path)
    || relative_path === ".."
    || relative_path.startsWith(`..${path.sep}`)) {
    return false;
  }
  return relative_path
    .split(path.sep)
    .slice(0, -1)
    .some((segment) => segment.toLowerCase() === directory_name.toLowerCase());
}

export function bundle_root_for_target(target_triple, uses_target_directory) {
  if (!uses_target_directory) {
    return DEFAULT_BUNDLE_ROOT;
  }
  if (typeof target_triple !== "string" || !/^[a-z0-9_.-]+$/i.test(target_triple)) {
    fail(`Invalid Rust target for bundle directory: ${target_triple}`);
  }
  return path.join(
    PROJECT_ROOT,
    "src-tauri",
    "target",
    target_triple,
    "release",
    "bundle",
  );
}

export function bundle_filename_has_version(file_name, version) {
  return file_name.split("_").includes(version);
}

function read_json(file_path) {
  return JSON.parse(readFileSync(file_path, "utf8"));
}

function normalized_path(file_path) {
  const normalized = path.normalize(path.resolve(file_path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolved_and_real_paths(file_path) {
  const resolved_path = path.resolve(file_path);
  const paths = [resolved_path];
  if (existsSync(resolved_path)) {
    try {
      paths.push(realpathSync.native(resolved_path));
    } catch {
      fail("Unable to resolve a local build path for release privacy verification");
    }
  }
  return [...new Set(paths)];
}

function local_build_paths(environment = process.env) {
  const configured_cargo_home = environment.CARGO_HOME;
  const cargo_home = typeof configured_cargo_home === "string" && configured_cargo_home.length > 0
    ? path.resolve(PROJECT_ROOT, configured_cargo_home)
    : path.join(homedir(), ".cargo");
  return [...new Set([
    ...resolved_and_real_paths(PROJECT_ROOT),
    ...resolved_and_real_paths(cargo_home),
  ])];
}

export function local_path_binary_needles(source_paths) {
  if (!Array.isArray(source_paths) || source_paths.length === 0) {
    fail("Local build paths are required for release privacy verification");
  }

  const needles = [];
  const seen_needles = new Set();
  for (const source_path of source_paths) {
    if (typeof source_path !== "string" || source_path.length < 2 || source_path.includes("\0")) {
      fail("A local build path is invalid for release privacy verification");
    }
    const path_variants = new Set([
      source_path,
      source_path.replaceAll("\\", "/"),
      source_path.replaceAll("/", "\\"),
    ]);
    for (const path_variant of path_variants) {
      for (const encoding of ["utf8", "utf16le"]) {
        const needle = Buffer.from(path_variant, encoding);
        const needle_key = needle.toString("hex");
        if (!seen_needles.has(needle_key)) {
          seen_needles.add(needle_key);
          needles.push(needle);
        }
      }
    }
  }
  return needles;
}

export function assert_no_local_paths_in_binary(binary, source_paths) {
  if (!Buffer.isBuffer(binary)) {
    fail("Release executable privacy verification requires binary data");
  }
  if (local_path_binary_needles(source_paths).some((needle) => binary.includes(needle))) {
    fail(
      "Release executable contains a local project or Cargo path; "
        + "rebuild it through pnpm tauri build",
    );
  }
}

function compare_stable(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assert_exact_keys(value, expected_keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual_keys = Object.keys(value);
  if (JSON.stringify(actual_keys) !== JSON.stringify(expected_keys)) {
    fail(`${label} fields or field order are invalid`);
  }
}

function assert_safe_value(value, label, pattern = null, maximum_length = 200) {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > maximum_length
    || [...value].some((character) => {
      const code_point = character.codePointAt(0);
      return code_point <= 0x1f || code_point === 0x7f;
    })
    || value.includes("/")
    || value.includes("\\")
    || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid`);
  }
}

function assert_semver(value, label) {
  assert_safe_value(value, label, SEMVER_PATTERN);
}

function assert_date(value, label) {
  assert_safe_value(value, label, /^\d{4}-\d{2}-\d{2}$/);
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day) {
    fail(`${label} is invalid`);
  }
}

function normalize_tool_output(output, label) {
  if (typeof output !== "string" || output.length === 0 || output.length > 4096) {
    fail(`${label} output is empty or too large`);
  }
  const normalized = output.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    fail(`${label} output contains unsupported line endings`);
  }
  return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

export function build_environment_file_name(target_triple) {
  assert_safe_value(target_triple, "Build environment Rust target", RUST_TARGET_PATTERN);
  return `${BUILD_ENVIRONMENT_PREFIX}-${target_triple}.json`;
}

export function parse_verbose_tool_version(output, tool_name) {
  if (tool_name !== "cargo" && tool_name !== "rustc") {
    fail(`Unsupported verbose tool: ${tool_name}`);
  }
  const normalized = normalize_tool_output(output, `${tool_name} -Vv`);
  const lines = normalized.split("\n");
  const banner = new RegExp(
    `^${tool_name} (\\S+) \\(([0-9a-f]{7,40}) (\\d{4}-\\d{2}-\\d{2})\\)$`,
  ).exec(lines[0]);
  if (!banner) {
    fail(`${tool_name} -Vv banner is invalid`);
  }

  const allowed_fields = tool_name === "cargo"
    ? new Set(["release", "commit-hash", "commit-date", "host", "libgit2", "libcurl", "ssl", "os"])
    : new Set(["binary", "commit-hash", "commit-date", "host", "release", "LLVM version"]);
  const fields = new Map();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(": ");
    if (separator <= 0) {
      fail(`${tool_name} -Vv contains an invalid field`);
    }
    const field_name = line.slice(0, separator);
    const field_value = line.slice(separator + 2);
    if (!allowed_fields.has(field_name) || fields.has(field_name)) {
      fail(`${tool_name} -Vv contains an unknown or duplicate field: ${field_name}`);
    }
    fields.set(field_name, field_value);
  }

  const required_fields = ["release", "commit-hash", "commit-date", "host"];
  if (tool_name === "rustc") {
    required_fields.push("binary", "LLVM version");
  }
  for (const field_name of required_fields) {
    if (!fields.has(field_name)) {
      fail(`${tool_name} -Vv is missing ${field_name}`);
    }
  }
  if (fields.get("release") !== banner[1]
    || !fields.get("commit-hash").startsWith(banner[2])
    || fields.get("commit-date") !== banner[3]) {
    fail(`${tool_name} -Vv banner does not match its fields`);
  }
  if (tool_name === "rustc" && fields.get("binary") !== "rustc") {
    fail("rustc -Vv reports an unexpected binary");
  }

  const version = {
    release: fields.get("release"),
    commit_hash: fields.get("commit-hash"),
    commit_date: fields.get("commit-date"),
    host: fields.get("host"),
  };
  assert_semver(version.release, `${tool_name} release`);
  assert_safe_value(version.commit_hash, `${tool_name} commit hash`, SOURCE_COMMIT_PATTERN);
  assert_date(version.commit_date, `${tool_name} commit date`);
  assert_safe_value(version.host, `${tool_name} host`, RUST_TARGET_PATTERN);

  if (tool_name === "rustc") {
    version.llvm_version = fields.get("LLVM version");
    assert_semver(version.llvm_version, "rustc LLVM version");
  }
  return version;
}

export function parse_linux_build_packages(output) {
  const normalized = normalize_tool_output(output, "dpkg-query");
  const packages = [];
  const seen_names = new Set();
  for (const line of normalized.split("\n")) {
    const fields = line.split("\t");
    if (fields.length !== 3) {
      fail("dpkg-query contains an invalid package record");
    }
    const [name, architecture, version] = fields;
    assert_safe_value(name, "Linux package name", /^[a-z0-9][a-z0-9+.-]*$/);
    assert_safe_value(architecture, "Linux package architecture", /^[a-z0-9][a-z0-9-]*$/);
    assert_safe_value(version, "Linux package version", /^[A-Za-z0-9.+:~_-]+$/);
    if (seen_names.has(name)) {
      fail(`dpkg-query contains a duplicate package: ${name}`);
    }
    seen_names.add(name);
    packages.push({ name, architecture, version });
  }
  const expected_names = [...LINUX_BUILD_PACKAGES];
  const actual_names = packages.map((entry) => entry.name).sort(compare_stable);
  if (JSON.stringify(actual_names) !== JSON.stringify(expected_names)) {
    fail("dpkg-query does not contain exactly the declared Linux build packages");
  }
  return packages.sort((left, right) => compare_stable(left.name, right.name));
}

function validate_toolchain(toolchain) {
  assert_exact_keys(toolchain, ["node", "pnpm", "tauri_cli", "cargo", "rustc"], "Toolchain");
  assert_semver(toolchain.node, "Node.js version");
  assert_semver(toolchain.pnpm, "pnpm version");
  assert_semver(toolchain.tauri_cli, "Tauri CLI version");
  assert_exact_keys(
    toolchain.cargo,
    ["release", "commit_hash", "commit_date", "host"],
    "Cargo version",
  );
  assert_exact_keys(
    toolchain.rustc,
    ["release", "commit_hash", "commit_date", "host", "llvm_version"],
    "rustc version",
  );
  for (const [tool_name, version] of [["cargo", toolchain.cargo], ["rustc", toolchain.rustc]]) {
    assert_semver(version.release, `${tool_name} release`);
    assert_safe_value(version.commit_hash, `${tool_name} commit hash`, SOURCE_COMMIT_PATTERN);
    assert_date(version.commit_date, `${tool_name} commit date`);
    assert_safe_value(version.host, `${tool_name} host`, RUST_TARGET_PATTERN);
  }
  assert_semver(toolchain.rustc.llvm_version, "rustc LLVM version");
  if (toolchain.cargo.release !== toolchain.rustc.release
    || toolchain.cargo.host !== toolchain.rustc.host) {
    fail("Cargo and rustc must report the same release and host");
  }
}

function validate_build_environment(record, expected = {}) {
  assert_exact_keys(
    record,
    [
      "schema_version",
      "project",
      "version",
      "source_commit",
      "source_dirty",
      "platform",
      "rust_target",
      "runner",
      "toolchain",
      "declared_system_packages",
    ],
    "Build environment",
  );
  if (record.schema_version !== 1 || record.project !== "vofa-ultra") {
    fail("Build environment schema or project is invalid");
  }
  assert_semver(record.version, "Build environment version");
  assert_safe_value(record.source_commit, "Build environment source commit", SOURCE_COMMIT_PATTERN);
  if (typeof record.source_dirty !== "boolean") {
    fail("Build environment source_dirty must be boolean");
  }
  if (!Object.hasOwn(BUILD_PLATFORMS, record.platform)) {
    fail(`Build environment platform is invalid: ${record.platform}`);
  }
  const platform = BUILD_PLATFORMS[record.platform];
  if (record.rust_target !== platform.target_triple) {
    fail(`Build environment target does not match ${record.platform}`);
  }
  assert_exact_keys(
    record.runner,
    ["os", "arch", "environment", "image_os", "image_version"],
    "Build environment runner",
  );
  if (record.runner.os !== platform.runner_os
    || record.runner.environment !== "github-hosted") {
    fail(`Build environment runner does not match ${record.platform}`);
  }
  assert_safe_value(record.runner.arch, "Runner architecture", /^(?:ARM64|X64)$/);
  assert_safe_value(record.runner.image_os, "Runner image OS", /^[A-Za-z0-9._+-]+$/);
  assert_safe_value(record.runner.image_version, "Runner image version", /^[A-Za-z0-9._+-]+$/);
  validate_toolchain(record.toolchain);
  const expected_host = platform.runner_hosts[record.runner.arch];
  if (!expected_host || record.toolchain.rustc.host !== expected_host) {
    fail(`Build environment toolchain host does not match ${record.platform} runner`);
  }

  if (!Array.isArray(record.declared_system_packages)) {
    fail("declared_system_packages must be an array");
  }
  const package_names = [];
  for (const package_record of record.declared_system_packages) {
    assert_exact_keys(package_record, ["name", "architecture", "version"], "System package");
    assert_safe_value(package_record.name, "System package name", /^[a-z0-9][a-z0-9+.-]*$/);
    assert_safe_value(package_record.architecture, "System package architecture", /^[a-z0-9][a-z0-9-]*$/);
    assert_safe_value(package_record.version, "System package version", /^[A-Za-z0-9.+:~_-]+$/);
    package_names.push(package_record.name);
  }
  const sorted_package_names = [...package_names].sort(compare_stable);
  if (JSON.stringify(package_names) !== JSON.stringify(sorted_package_names)) {
    fail("System packages must use stable name order");
  }
  const expected_package_names = record.platform === "linux" ? [...LINUX_BUILD_PACKAGES] : [];
  if (JSON.stringify(package_names) !== JSON.stringify(expected_package_names)) {
    fail(`Build environment system packages do not match ${record.platform}`);
  }

  const expected_fields = {
    platform: "platform",
    rust_target: "rust_target",
    source_commit: "source_commit",
    source_dirty: "source_dirty",
    version: "version",
  };
  for (const [option_name, record_name] of Object.entries(expected_fields)) {
    if (Object.hasOwn(expected, option_name) && record[record_name] !== expected[option_name]) {
      fail(`Build environment ${record_name} does not match the release`);
    }
  }
  return record;
}

export function serialize_build_environment(record) {
  validate_build_environment(record);
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function parse_and_validate_build_environment(text, expected = {}) {
  if (typeof text !== "string"
    || Buffer.byteLength(text, "utf8") > BUILD_ENVIRONMENT_MAX_BYTES
    || !text.endsWith("\n")
    || text.includes("\r")
    || text.startsWith("\ufeff")) {
    fail("Build environment JSON must be UTF-8 canonical JSON with LF line endings");
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Build environment JSON is invalid: ${detail}`);
  }
  validate_build_environment(record, expected);
  if (`${JSON.stringify(record, null, 2)}\n` !== text) {
    fail("Build environment JSON is not canonical");
  }
  return record;
}

function required_environment_value(environment, variable_name) {
  const value = environment[variable_name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`GitHub build environment is missing ${variable_name}`);
  }
  return value;
}

export function build_ci_environment(options) {
  const {
    environment,
    platform_name,
    source,
    target_triple,
    tools,
    version,
  } = options;
  if (environment?.GITHUB_ACTIONS !== "true") {
    fail("Build environment records require GitHub Actions");
  }
  const platform = BUILD_PLATFORMS[platform_name];
  if (!platform || target_triple !== platform.target_triple) {
    fail(`GitHub build target does not match platform ${platform_name}`);
  }
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    fail("GitHub build source is invalid");
  }
  assert_safe_value(source.source_commit, "Source commit", SOURCE_COMMIT_PATTERN);
  if (source.source_dirty !== false) {
    fail("GitHub build source must be clean before packaging");
  }

  const github_sha = required_environment_value(environment, "GITHUB_SHA");
  const runner_arch = required_environment_value(environment, "RUNNER_ARCH");
  const runner_environment = required_environment_value(environment, "RUNNER_ENVIRONMENT");
  const runner_os = required_environment_value(environment, "RUNNER_OS");
  const image_os = required_environment_value(environment, "ImageOS");
  const image_version = required_environment_value(environment, "ImageVersion");
  if (github_sha !== source.source_commit) {
    fail("GitHub build source does not match GITHUB_SHA");
  }
  if (runner_os !== platform.runner_os || runner_environment !== "github-hosted") {
    fail(`GitHub runner does not match platform ${platform_name}`);
  }
  if (tools === null || typeof tools !== "object" || Array.isArray(tools)) {
    fail("GitHub build tool samples are invalid");
  }

  const declared_system_packages = platform_name === "linux"
    ? parse_linux_build_packages(tools.linux_packages)
    : [];
  if (platform_name !== "linux"
    && tools.linux_packages !== null
    && tools.linux_packages !== undefined
    && tools.linux_packages !== "") {
    fail(`GitHub build contains unexpected Linux packages for ${platform_name}`);
  }
  return serialize_build_environment({
    schema_version: 1,
    project: "vofa-ultra",
    version,
    source_commit: source.source_commit,
    source_dirty: source.source_dirty,
    platform: platform_name,
    rust_target: target_triple,
    runner: {
      os: runner_os,
      arch: runner_arch,
      environment: runner_environment,
      image_os,
      image_version,
    },
    toolchain: {
      node: tools.node,
      pnpm: tools.pnpm,
      tauri_cli: tools.tauri_cli,
      cargo: parse_verbose_tool_version(tools.cargo_verbose, "cargo"),
      rustc: parse_verbose_tool_version(tools.rustc_verbose, "rustc"),
    },
    declared_system_packages,
  });
}

function run_command(command, args, label) {
  try {
    return execFileSync(command, args, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to read ${label}: ${detail}`);
  }
}

export function pnpm_version_from_user_agent(user_agent) {
  if (typeof user_agent !== "string") {
    return null;
  }
  const match = /^pnpm\/([^\s]+)/.exec(user_agent);
  if (!match) {
    return null;
  }
  const version = match[1];
  assert_semver(version, "pnpm version");
  return version;
}

function read_actual_pnpm_version() {
  const user_agent_version = pnpm_version_from_user_agent(process.env.npm_config_user_agent);
  if (user_agent_version !== null) {
    return user_agent_version;
  }
  const npm_exec_path = process.env.npm_execpath;
  const output = npm_exec_path
    ? run_command(process.execPath, [npm_exec_path, "--version"], "pnpm version")
    : run_command(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--version"], "pnpm version");
  const version = normalize_tool_output(output, "pnpm");
  assert_semver(version, "pnpm version");
  return version;
}

function read_source_state() {
  const source_commit = normalize_tool_output(
    run_command("git", ["rev-parse", "HEAD^{commit}"], "source commit"),
    "git rev-parse",
  );
  assert_safe_value(source_commit, "Source commit", SOURCE_COMMIT_PATTERN);
  const status = run_command(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "source status",
  );
  return { source_commit, source_dirty: status.length > 0 };
}

function capture_build_environment(version, platform_name, target_triple) {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return null;
  }
  const source = read_source_state();
  const tauri_cli_package = read_json(TAURI_CLI_PACKAGE_PATH);
  const linux_packages = platform_name === "linux"
    ? run_command(
      "dpkg-query",
      [
        "--show",
        "--showformat=${Package}\\t${Architecture}\\t${Version}\\n",
        ...LINUX_BUILD_PACKAGES,
      ],
      "declared Linux build packages",
    )
    : null;
  return build_ci_environment({
    environment: process.env,
    platform_name,
    source,
    target_triple,
    tools: {
      node: process.versions.node,
      pnpm: read_actual_pnpm_version(),
      tauri_cli: tauri_cli_package.version,
      cargo_verbose: run_command("cargo", ["-Vv"], "Cargo version"),
      rustc_verbose: run_command("rustc", ["-Vv"], "rustc version"),
      linux_packages,
    },
    version,
  });
}

function read_cargo_package() {
  const cargo_command = process.env.CARGO || "cargo";
  let metadata;

  try {
    metadata = JSON.parse(
      execFileSync(
        cargo_command,
        [
          "metadata",
          "--locked",
          "--no-deps",
          "--format-version",
          "1",
          "--manifest-path",
          CARGO_MANIFEST_PATH,
        ],
        {
          cwd: PROJECT_ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to read Cargo metadata: ${detail}`);
  }

  const expected_manifest = normalized_path(CARGO_MANIFEST_PATH);
  const cargo_package = metadata.packages.find(
    (candidate) => normalized_path(candidate.manifest_path) === expected_manifest,
  );

  if (!cargo_package) {
    fail(`Cargo metadata does not contain ${CARGO_MANIFEST_PATH}`);
  }

  return cargo_package;
}

export function validate_repository_metadata(package_manifest, tauri_config, cargo_package) {
  if (package_manifest?.repository?.type !== "git") {
    fail('package.json repository.type must be "git"');
  }

  if (package_manifest.repository.url !== PROJECT_RELEASE_COORDINATES.npm_repository) {
    fail(`package.json repository.url must be ${PROJECT_RELEASE_COORDINATES.npm_repository}`);
  }

  if (package_manifest.homepage !== PROJECT_RELEASE_COORDINATES.homepage) {
    fail(`package.json homepage must be ${PROJECT_RELEASE_COORDINATES.homepage}`);
  }

  if (package_manifest.bugs?.url !== PROJECT_RELEASE_COORDINATES.issues) {
    fail(`package.json bugs.url must be ${PROJECT_RELEASE_COORDINATES.issues}`);
  }

  if (cargo_package?.repository !== PROJECT_RELEASE_COORDINATES.cargo_repository) {
    fail(`Cargo repository must be ${PROJECT_RELEASE_COORDINATES.cargo_repository}`);
  }

  if (cargo_package.homepage !== PROJECT_RELEASE_COORDINATES.cargo_homepage) {
    fail(`Cargo homepage must be ${PROJECT_RELEASE_COORDINATES.cargo_homepage}`);
  }

  if (tauri_config?.identifier !== PROJECT_RELEASE_COORDINATES.tauri_identifier) {
    fail(`Tauri identifier must be ${PROJECT_RELEASE_COORDINATES.tauri_identifier}`);
  }
}

function verify_package_metadata() {
  const package_manifest = read_json(PACKAGE_PATH);
  const tauri_config = read_json(TAURI_CONFIG_PATH);
  const cargo_package = read_cargo_package();
  const versions = new Set([package_manifest.version, tauri_config.version, cargo_package.version]);

  if (versions.size !== 1) {
    fail(
      `Package versions differ: package.json=${package_manifest.version}, ` +
        `tauri.conf.json=${tauri_config.version}, Cargo.toml=${cargo_package.version}`,
    );
  }

  if (package_manifest.name !== cargo_package.name) {
    fail(
      `Package names differ: package.json=${package_manifest.name}, ` +
        `Cargo.toml=${cargo_package.name}`,
    );
  }

  if (
    package_manifest.license !== cargo_package.license
    || package_manifest.license !== tauri_config.bundle?.license
  ) {
    fail(
      `Package licenses differ: package.json=${package_manifest.license}, `
        + `tauri.conf.json=${tauri_config.bundle?.license}, Cargo.toml=${cargo_package.license}`,
    );
  }

  validate_repository_metadata(package_manifest, tauri_config, cargo_package);

  if (tauri_config.bundle?.active !== true) {
    fail("Tauri bundling must be active");
  }

  if (tauri_config.bundle.targets !== "all") {
    fail('Tauri bundle targets must be "all"; the build command narrows targets per platform');
  }

  if (tauri_config.build?.beforeBuildCommand !== "pnpm build:desktop") {
    fail("Tauri beforeBuildCommand must generate supply-chain artifacts before compilation");
  }

  if (tauri_config.bundle.resources?.["gen/supply-chain/*"] !== "supply-chain/") {
    fail("Tauri bundle resources must include generated supply-chain artifacts");
  }

  if (!Array.isArray(tauri_config.bundle.icon) || tauri_config.bundle.icon.length === 0) {
    fail("Tauri bundle icons must be configured");
  }

  const required_bundle_fields = [
    "publisher",
    "copyright",
    "license",
    "licenseFile",
    "category",
    "shortDescription",
    "longDescription",
  ];

  for (const field_name of required_bundle_fields) {
    if (typeof tauri_config.bundle[field_name] !== "string" || !tauri_config.bundle[field_name].trim()) {
      fail(`Tauri bundle field must be a non-empty string: ${field_name}`);
    }
  }

  for (const icon_path of tauri_config.bundle.icon) {
    const resolved_icon = path.resolve(path.dirname(TAURI_CONFIG_PATH), icon_path);
    if (!existsSync(resolved_icon)) {
      fail(`Bundle icon does not exist: ${icon_path}`);
    }
  }

  if (tauri_config.bundle.licenseFile) {
    const license_path = path.resolve(
      path.dirname(TAURI_CONFIG_PATH),
      tauri_config.bundle.licenseFile,
    );
    if (!existsSync(license_path)) {
      fail(`Bundle license file does not exist: ${tauri_config.bundle.licenseFile}`);
    }
  }

  if (process.env.GITHUB_REF_TYPE === "tag") {
    const expected_tag = `v${package_manifest.version}`;
    if (process.env.GITHUB_REF_NAME !== expected_tag) {
      fail(`Release tag must be ${expected_tag}, received ${process.env.GITHUB_REF_NAME}`);
    }
  }

  console.log(`Verified package metadata for ${tauri_config.productName} v${package_manifest.version}`);
  return package_manifest.version;
}

async function list_files(directory_path) {
  const entries = await readdir(directory_path, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entry_path = path.join(directory_path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await list_files(entry_path)));
    } else if (entry.isFile()) {
      files.push(entry_path);
    }
  }

  return files;
}

async function hash_file(file_path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file_path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function verify_release_executable_privacy(platform_name, bundle_root) {
  const executable_name = platform_name === "windows" ? "vofa-ultra.exe" : "vofa-ultra";
  const executable_path = path.join(path.dirname(bundle_root), executable_name);
  if (!existsSync(executable_path)) {
    fail("Release executable is missing beside the bundle directory");
  }

  const executable_stat = await stat(executable_path);
  if (!executable_stat.isFile() || executable_stat.size === 0) {
    fail("Release executable is not a non-empty regular file");
  }
  assert_no_local_paths_in_binary(
    readFileSync(executable_path),
    local_build_paths(),
  );
}

async function collect_artifacts(platform_name, explicit_target) {
  const {
    resolve_target_triple,
    verify_supply_chain_artifacts,
  } = await import("./supply-chain.mjs");
  const artifact_specs = PLATFORM_ARTIFACTS[platform_name];
  if (!artifact_specs) {
    fail(
      `Unknown platform ${platform_name}; ` +
        `expected ${Object.keys(PLATFORM_ARTIFACTS).join(", ")}`,
    );
  }

  const version = verify_package_metadata();
  const target_triple = resolve_target_triple(explicit_target);
  const configured_target = explicit_target
    ?? process.env.TAURI_ENV_TARGET_TRIPLE
    ?? process.env.CARGO_BUILD_TARGET;
  const bundle_root = bundle_root_for_target(target_triple, Boolean(configured_target));
  const output_directory = path.join(PROJECT_ROOT, "artifacts", platform_name);

  if (!existsSync(bundle_root)) {
    fail(`Bundle directory does not exist: ${bundle_root}`);
  }

  if (existsSync(output_directory) && (await readdir(output_directory)).length > 0) {
    fail(`Artifact output directory is not empty: ${output_directory}`);
  }

  await verify_release_executable_privacy(platform_name, bundle_root);

  const bundle_files = await list_files(bundle_root);
  const selected_files = new Set();

  for (const artifact_spec of artifact_specs) {
    const matches = bundle_files.filter((file_path) => (
      artifact_spec.matches(file_path, bundle_root)
    ));
    if (matches.length === 0) {
      fail(`Missing ${artifact_spec.label} in ${bundle_root}`);
    }
    for (const match of matches) {
      selected_files.add(match);
    }
  }

  const sorted_files = [...selected_files].sort(compare_stable);
  const file_names = new Set();

  await mkdir(output_directory, { recursive: true });

  for (const source_path of sorted_files) {
    const file_name = path.basename(source_path);
    if (!bundle_filename_has_version(file_name, version)) {
      fail(`Bundle filename does not contain version ${version}: ${file_name}`);
    }
    if (file_names.has(file_name)) {
      fail(`Bundle filename collision: ${file_name}`);
    }

    const source_stat = await stat(source_path);
    if (source_stat.size === 0) {
      fail(`Bundle is empty: ${source_path}`);
    }

    file_names.add(file_name);
    await copyFile(source_path, path.join(output_directory, file_name));
  }

  const license_name = path.basename(LICENSE_PATH);
  if (file_names.has(license_name)) {
    fail(`Artifact filename collision: ${license_name}`);
  }
  await copyFile(LICENSE_PATH, path.join(output_directory, license_name));
  file_names.add(license_name);

  const supply_chain = await verify_supply_chain_artifacts({
    output_directory: BUNDLE_SUPPLY_CHAIN_ROOT,
    platform_name,
    target_triple,
  });
  for (const supply_chain_name of supply_chain.file_names) {
    if (file_names.has(supply_chain_name)) {
      fail(`Artifact filename collision: ${supply_chain_name}`);
    }
    await copyFile(
      path.join(BUNDLE_SUPPLY_CHAIN_ROOT, supply_chain_name),
      path.join(output_directory, supply_chain_name),
    );
    file_names.add(supply_chain_name);
  }

  const build_environment = capture_build_environment(version, platform_name, target_triple);
  if (build_environment !== null) {
    const environment_name = build_environment_file_name(target_triple);
    if (file_names.has(environment_name)) {
      fail(`Artifact filename collision: ${environment_name}`);
    }
    await writeFile(path.join(output_directory, environment_name), build_environment, "utf8");
    file_names.add(environment_name);
  }

  const checksum_lines = [];
  const staged_files = (await list_files(output_directory))
    .sort((left, right) => compare_stable(path.basename(left), path.basename(right)));
  for (const staged_path of staged_files) {
    const staged_name = path.basename(staged_path);
    checksum_lines.push(`${await hash_file(staged_path)}  ${staged_name}`);
  }

  await writeFile(
    path.join(output_directory, "SHA256SUMS"),
    `${checksum_lines.join("\n")}\n`,
    "utf8",
  );
  console.log(
    `Staged ${sorted_files.length} ${platform_name} bundle(s) and `
      + `${supply_chain.component_count} dependency records for ${target_triple} `
      + `${build_environment === null ? "without" : "with"} a build environment record `
      + `in ${output_directory}`,
  );
}

async function main() {
  const [command, platform_name, target_triple] = process.argv.slice(2);

  if (command === "verify") {
    verify_package_metadata();
    return;
  }

  if (command === "collect" && platform_name) {
    await collect_artifacts(platform_name, target_triple);
    return;
  }

  fail(
    "Usage: package-artifacts.mjs verify "
      + "| collect <linux|macos|windows> [target-triple]",
  );
}

const is_main = process.argv[1]
  && normalized_path(process.argv[1]) === normalized_path(fileURLToPath(import.meta.url));
if (is_main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
