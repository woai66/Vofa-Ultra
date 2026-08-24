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
const DEFAULT_BUNDLE_ROOT = path.join(PROJECT_ROOT, "src-tauri", "target", "release", "bundle");

const PLATFORM_ARTIFACTS = {
  linux: [
    {
      label: "Debian package",
      matches: (file_path) =>
        has_parent(file_path, "deb") && file_path.toLowerCase().endsWith(".deb"),
    },
    {
      label: "AppImage",
      matches: (file_path) =>
        has_parent(file_path, "appimage") && file_path.endsWith(".AppImage"),
    },
  ],
  macos: [
    {
      label: "macOS disk image",
      matches: (file_path) =>
        has_parent(file_path, "dmg") && file_path.toLowerCase().endsWith(".dmg"),
    },
  ],
  windows: [
    {
      label: "Windows Installer package",
      matches: (file_path) =>
        has_parent(file_path, "msi") && file_path.toLowerCase().endsWith(".msi"),
    },
    {
      label: "NSIS installer",
      matches: (file_path) =>
        has_parent(file_path, "nsis") && file_path.toLowerCase().endsWith(".exe"),
    },
  ],
};

function fail(message) {
  throw new Error(message);
}

function has_parent(file_path, directory_name) {
  return path
    .relative(DEFAULT_BUNDLE_ROOT, file_path)
    .split(path.sep)
    .slice(0, -1)
    .some((segment) => segment.toLowerCase() === directory_name.toLowerCase());
}

function read_json(file_path) {
  return JSON.parse(readFileSync(file_path, "utf8"));
}

function normalized_path(file_path) {
  const normalized = path.normalize(path.resolve(file_path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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

  if (tauri_config.bundle?.active !== true) {
    fail("Tauri bundling must be active");
  }

  if (tauri_config.bundle.targets !== "all") {
    fail('Tauri bundle targets must be "all"; CI narrows targets per platform');
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

async function collect_artifacts(platform_name) {
  const artifact_specs = PLATFORM_ARTIFACTS[platform_name];
  if (!artifact_specs) {
    fail(
      `Unknown platform ${platform_name}; ` +
        `expected ${Object.keys(PLATFORM_ARTIFACTS).join(", ")}`,
    );
  }

  const version = verify_package_metadata();
  const bundle_root = DEFAULT_BUNDLE_ROOT;
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
    const matches = bundle_files.filter(artifact_spec.matches);
    if (matches.length === 0) {
      fail(`Missing ${artifact_spec.label} in ${bundle_root}`);
    }
    for (const match of matches) {
      selected_files.add(match);
    }
  }

  const sorted_files = [...selected_files].sort((left, right) => left.localeCompare(right));
  const file_names = new Set();
  const checksum_lines = [];

  await mkdir(output_directory, { recursive: true });

  for (const source_path of sorted_files) {
    const file_name = path.basename(source_path);
    if (!file_name.includes(version)) {
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
    checksum_lines.push(`${await hash_file(source_path)}  ${file_name}`);
  }

  await writeFile(
    path.join(output_directory, "SHA256SUMS"),
    `${checksum_lines.join("\n")}\n`,
    "utf8",
  );
  console.log(
    `Staged ${sorted_files.length} ${platform_name} bundle(s) in ${output_directory}`,
  );
}

async function main() {
  const [command, platform_name] = process.argv.slice(2);

  if (command === "verify") {
    verify_package_metadata();
    return;
  }

  if (command === "collect" && platform_name) {
    await collect_artifacts(platform_name);
    return;
  }

  fail("Usage: package-artifacts.mjs verify | collect <linux|macos|windows>");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
