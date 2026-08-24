#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = path.join(PROJECT_ROOT, "package.json");
const TAURI_CONFIG_PATH = path.join(PROJECT_ROOT, "src-tauri", "tauri.conf.json");
const CARGO_MANIFEST_PATH = path.join(PROJECT_ROOT, "src-tauri", "Cargo.toml");
const LICENSE_PATH = path.join(PROJECT_ROOT, "LICENSE");
const BUNDLE_SUPPLY_CHAIN_ROOT = path.join(
  PROJECT_ROOT,
  "src-tauri",
  "gen",
  "supply-chain",
);
const DEFAULT_BUNDLE_ROOT = path.join(PROJECT_ROOT, "src-tauri", "target", "release", "bundle");

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

function compare_stable(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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

  if (tauri_config.bundle?.active !== true) {
    fail("Tauri bundling must be active");
  }

  if (tauri_config.bundle.targets !== "all") {
    fail('Tauri bundle targets must be "all"; CI narrows targets per platform');
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
