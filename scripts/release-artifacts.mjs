#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_ENVIRONMENT_MAX_BYTES,
  build_environment_file_name,
  bundle_filename_has_version,
  parse_and_validate_build_environment,
  WINDOWS_BETA_TARGET,
} from "./package-artifacts.mjs";
import { verify_supply_chain_artifacts } from "./supply-chain.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = path.join(PROJECT_ROOT, "package.json");
const LICENSE_PATH = path.join(PROJECT_ROOT, "LICENSE");
const CHANGELOG_PATH = path.join(PROJECT_ROOT, "CHANGELOG.md");
const RELEASE_CHECKSUM_NAME = "SHA256SUMS";
const RELEASE_CHANGELOG_NAME = "RELEASE_CHANGELOG.md";
const RELEASE_BUILD_INFO_NAME = "RELEASE_BUILD_INFO.json";
const SOURCE_SUPPLY_CHECKSUM_NAME = "SUPPLY_CHAIN_SHA256SUMS";

export const RELEASE_PLATFORMS = Object.freeze({
  windows: Object.freeze({
    target_triple: WINDOWS_BETA_TARGET,
    installers: Object.freeze([
      Object.freeze({ label: "NSIS installer", suffix: ".exe" }),
    ]),
  }),
});

function fail(message) {
  throw new Error(message);
}

function compare_stable(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function is_prerelease_version(version) {
  return version.startsWith("0.") || version.includes("-");
}

function normalize_changelog_lines(text) {
  if (typeof text !== "string") {
    fail("CHANGELOG.md must be text");
  }
  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    fail("CHANGELOG.md contains unsupported line endings");
  }
  return normalized.split("\n");
}

function find_changelog_section(lines, heading_pattern, label) {
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (heading_pattern.test(lines[index])) {
      matches.push(index);
    }
  }
  if (matches.length !== 1) {
    fail(`CHANGELOG.md must contain exactly one ${label}`);
  }
  const start = matches[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }
  return {
    end,
    lines: lines.slice(start, end),
  };
}

function release_heading_pattern(version) {
  const escaped_version = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^## \\[${escaped_version}\\](?: - \\d{4}-\\d{2}-\\d{2})?$`,
  );
}

function extract_release_changelog_from_lines(lines, version) {
  const section = find_changelog_section(
    lines,
    release_heading_pattern(version),
    `release section for ${version}`,
  );
  const section_lines = section.lines;
  while (section_lines.at(-1) === "") {
    section_lines.pop();
  }
  if (!section_lines.some((line) => line.startsWith("### "))
    || !section_lines.some((line) => line.startsWith("- "))) {
    fail(`CHANGELOG.md release section for ${version} must contain categorized entries`);
  }
  return `${section_lines.join("\n")}\n`;
}

export function extract_release_changelog(text, version) {
  return extract_release_changelog_from_lines(normalize_changelog_lines(text), version);
}

export function validate_release_changelog(text, version) {
  const lines = normalize_changelog_lines(text);
  const unreleased = find_changelog_section(
    lines,
    /^## \[Unreleased\]$/,
    "Unreleased section",
  );
  if (unreleased.lines.slice(1).some((line) => line.trim() !== "")) {
    fail("CHANGELOG.md Unreleased section must be empty before release");
  }
  const first_release_heading = lines[unreleased.end];
  if (first_release_heading === undefined
    || !release_heading_pattern(version).test(first_release_heading)) {
    fail(`CHANGELOG.md first release section after Unreleased must be ${version}`);
  }
  return extract_release_changelog_from_lines(lines, version);
}

async function sha256_file(file_path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file_path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function paths_overlap(left_path, right_path) {
  const left = path.resolve(left_path);
  const right = path.resolve(right_path);
  const relative = path.relative(left, right);
  const reverse_relative = path.relative(right, left);
  const left_contains_right = relative.length === 0
    || (!path.isAbsolute(relative)
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`));
  const right_contains_left = reverse_relative.length === 0
    || (!path.isAbsolute(reverse_relative)
      && reverse_relative !== ".."
      && !reverse_relative.startsWith(`..${path.sep}`));
  return left_contains_right || right_contains_left;
}

function assert_safe_file_name(file_name, label) {
  if (typeof file_name !== "string"
    || file_name.length === 0
    || file_name === "."
    || file_name === ".."
    || file_name.includes("/")
    || file_name.includes("\\")
    || path.basename(file_name) !== file_name) {
    fail(`${label} contains an unsafe filename: ${file_name}`);
  }
}

export function parse_checksum_manifest(text, label = RELEASE_CHECKSUM_NAME) {
  if (typeof text !== "string" || !text.endsWith("\n") || text.includes("\r")) {
    fail(`${label} must use LF line endings and end with a newline`);
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    fail(`${label} must contain at least one checksum entry`);
  }

  const checksums = new Map();
  let previous_name = null;
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      fail(`${label} contains an invalid checksum line: ${line}`);
    }
    const [, hash, file_name] = match;
    assert_safe_file_name(file_name, label);
    if (file_name === label || checksums.has(file_name)) {
      fail(`${label} contains a duplicate or self-reference: ${file_name}`);
    }
    if (previous_name !== null && compare_stable(previous_name, file_name) >= 0) {
      fail(`${label} entries must use stable filename order`);
    }
    checksums.set(file_name, hash);
    previous_name = file_name;
  }
  return checksums;
}

export async function verify_checksum_directory(
  directory_path,
  manifest_name = RELEASE_CHECKSUM_NAME,
) {
  const directory = path.resolve(directory_path);
  const manifest_path = path.join(directory, manifest_name);
  if (!existsSync(manifest_path)) {
    fail(`Checksum manifest is missing: ${manifest_path}`);
  }
  const checksums = parse_checksum_manifest(
    await readFile(manifest_path, "utf8"),
    manifest_name,
  );
  const entries = await readdir(directory, { withFileTypes: true });
  const actual_names = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      fail(`Release artifact directory must be flat: ${path.join(directory, entry.name)}`);
    }
    if (entry.name !== manifest_name) {
      actual_names.push(entry.name);
    }
  }
  actual_names.sort(compare_stable);
  if (actual_names.length !== checksums.size
    || actual_names.some((file_name) => !checksums.has(file_name))) {
    fail(`${manifest_name} does not exactly cover ${directory}`);
  }
  for (const file_name of actual_names) {
    const file_path = path.join(directory, file_name);
    const file_stat = await stat(file_path);
    if (file_stat.size === 0) {
      fail(`Release artifact is empty: ${file_path}`);
    }
    if (await sha256_file(file_path) !== checksums.get(file_name)) {
      fail(`Checksum mismatch for release artifact: ${file_name}`);
    }
  }
  return actual_names;
}

function expected_supply_chain_names(target_triple) {
  return [
    SOURCE_SUPPLY_CHECKSUM_NAME,
    `THIRD_PARTY_NOTICES-${target_triple}.txt`,
    `vofa-ultra-${target_triple}.cdx.json`,
  ].sort(compare_stable);
}

function select_installers(file_names, platform_name, version) {
  const platform = RELEASE_PLATFORMS[platform_name];
  const selected = [];
  for (const installer of platform.installers) {
    const matches = file_names.filter((file_name) => (
      file_name.toLowerCase().endsWith(installer.suffix)
    ));
    if (matches.length !== 1) {
      fail(
        `Expected exactly one ${installer.label} for ${platform_name}, found ${matches.length}`,
      );
    }
    if (!bundle_filename_has_version(matches[0], version)) {
      fail(`Release bundle filename does not contain version ${version}: ${matches[0]}`);
    }
    selected.push(matches[0]);
  }
  return selected.sort(compare_stable);
}

async function verify_platform_artifact(options) {
  const {
    artifact_directory,
    platform_name,
    source_commit,
    version,
    verify_supply_chain,
  } = options;
  const platform = RELEASE_PLATFORMS[platform_name];
  const file_names = await verify_checksum_directory(artifact_directory);
  const installers = select_installers(file_names, platform_name, version);
  const license_path = path.join(artifact_directory, "LICENSE");
  if (!existsSync(license_path)
    || !readFileSync(license_path).equals(readFileSync(LICENSE_PATH))) {
    fail(`Release artifact LICENSE does not match the repository for ${platform_name}`);
  }

  const supply_chain = await verify_supply_chain({
    output_directory: artifact_directory,
    platform_name,
    target_triple: platform.target_triple,
  });
  if (supply_chain.platform_name !== platform_name
    || supply_chain.target_triple !== platform.target_triple) {
    fail(`Supply-chain verifier returned the wrong target for ${platform_name}`);
  }
  const supply_chain_names = [...supply_chain.file_names].sort(compare_stable);
  const expected_supply_names = expected_supply_chain_names(platform.target_triple);
  if (JSON.stringify(supply_chain_names) !== JSON.stringify(expected_supply_names)) {
    fail(`Supply-chain verifier returned an unexpected file set for ${platform_name}`);
  }

  const build_environment_name = build_environment_file_name(platform.target_triple);
  const build_environment_path = path.join(artifact_directory, build_environment_name);
  if (!existsSync(build_environment_path)) {
    fail(`Build environment record is missing for ${platform_name}`);
  }
  const build_environment_stat = await stat(build_environment_path);
  if (build_environment_stat.size > BUILD_ENVIRONMENT_MAX_BYTES) {
    fail(`Build environment record is too large for ${platform_name}`);
  }
  parse_and_validate_build_environment(
    await readFile(build_environment_path, "utf8"),
    {
      platform: platform_name,
      rust_target: platform.target_triple,
      source_commit,
      source_dirty: false,
      version,
    },
  );

  const expected_names = new Set([
    "LICENSE",
    build_environment_name,
    ...installers,
    ...supply_chain_names,
  ]);
  if (file_names.length !== expected_names.size
    || file_names.some((file_name) => !expected_names.has(file_name))) {
    fail(`Release artifact contains an unexpected file for ${platform_name}`);
  }
  return { build_environment_name, installers, supply_chain_names };
}

async function copy_release_asset(options) {
  const {
    source_path,
    output_directory,
    output_name,
    staged_names,
  } = options;
  assert_safe_file_name(output_name, "Release output");
  if (output_name === RELEASE_CHECKSUM_NAME || staged_names.has(output_name)) {
    fail(`Release asset filename collision: ${output_name}`);
  }
  const source_stat = await stat(source_path);
  if (source_stat.size === 0) {
    fail(`Release asset source is empty: ${source_path}`);
  }
  await copyFile(source_path, path.join(output_directory, output_name));
  staged_names.add(output_name);
}

function read_project_version() {
  const package_manifest = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
  if (typeof package_manifest.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(package_manifest.version)) {
    fail("package.json version is not a supported release version");
  }
  return package_manifest.version;
}

export async function stage_release_artifacts(options) {
  const input_root = path.resolve(options.input_root);
  const output_root = path.resolve(options.output_root);
  const run_number = String(options.run_number ?? "");
  const run_id = String(options.run_id ?? "");
  const run_attempt = String(options.run_attempt ?? "");
  const tag_name = options.tag_name;
  const source_commit = String(options.source_commit ?? "");
  const version = read_project_version();
  const changelog = validate_release_changelog(
    options.changelog_text ?? readFileSync(CHANGELOG_PATH, "utf8"),
    version,
  );
  const verify_supply_chain = options.verify_supply_chain ?? verify_supply_chain_artifacts;

  if (!/^[1-9]\d*$/.test(run_number)) {
    fail(`GitHub run number is invalid: ${run_number}`);
  }
  if (!/^[1-9]\d*$/.test(run_id) || !/^[1-9]\d*$/.test(run_attempt)) {
    fail(`GitHub run identity is invalid: ${run_id}/${run_attempt}`);
  }
  if (tag_name !== `v${version}`) {
    fail(`Release tag must be v${version}, received ${tag_name}`);
  }
  if (!/^[0-9a-f]{40}$/.test(source_commit)) {
    fail(`Release source commit is invalid: ${source_commit}`);
  }
  if (!existsSync(input_root)) {
    fail(`Downloaded artifact root does not exist: ${input_root}`);
  }
  if (output_root === PROJECT_ROOT || paths_overlap(input_root, output_root)) {
    fail("Release input and output directories must be separate");
  }
  if (existsSync(output_root) && (await readdir(output_root)).length > 0) {
    fail(`Release output directory is not empty: ${output_root}`);
  }

  const platform_names = Object.keys(RELEASE_PLATFORMS).sort(compare_stable);
  const expected_directories = platform_names.map(
    (platform_name) => `vofa-ultra-${platform_name}-${run_number}-${run_attempt}`,
  );
  const input_entries = await readdir(input_root, { withFileTypes: true });
  const input_names = input_entries.map((entry) => entry.name).sort(compare_stable);
  if (input_entries.some((entry) => !entry.isDirectory())
    || JSON.stringify(input_names) !== JSON.stringify(expected_directories)) {
    fail("Downloaded artifact root must contain exactly the current-run Windows artifact");
  }

  await mkdir(output_root, { recursive: true });
  const staged_names = new Set();
  let license_staged = false;

  for (const platform_name of platform_names) {
    const artifact_directory = path.join(
      input_root,
      `vofa-ultra-${platform_name}-${run_number}-${run_attempt}`,
    );
    const verified = await verify_platform_artifact({
      artifact_directory,
      platform_name,
      source_commit,
      version,
      verify_supply_chain,
    });
    const target_triple = RELEASE_PLATFORMS[platform_name].target_triple;
    for (const installer_name of verified.installers) {
      await copy_release_asset({
        source_path: path.join(artifact_directory, installer_name),
        output_directory: output_root,
        output_name: installer_name,
        staged_names,
      });
    }
    await copy_release_asset({
      source_path: path.join(artifact_directory, verified.build_environment_name),
      output_directory: output_root,
      output_name: verified.build_environment_name,
      staged_names,
    });
    for (const supply_name of verified.supply_chain_names) {
      const output_name = supply_name === SOURCE_SUPPLY_CHECKSUM_NAME
        ? `${SOURCE_SUPPLY_CHECKSUM_NAME}-${target_triple}`
        : supply_name;
      await copy_release_asset({
        source_path: path.join(artifact_directory, supply_name),
        output_directory: output_root,
        output_name,
        staged_names,
      });
    }
    if (!license_staged) {
      await copy_release_asset({
        source_path: path.join(artifact_directory, "LICENSE"),
        output_directory: output_root,
        output_name: "LICENSE",
        staged_names,
      });
      license_staged = true;
    }
  }

  await writeFile(path.join(output_root, RELEASE_CHANGELOG_NAME), changelog, "utf8");
  staged_names.add(RELEASE_CHANGELOG_NAME);

  const prerelease = is_prerelease_version(version);
  const build_info = {
    schema_version: 1,
    project: "vofa-ultra",
    version,
    tag_name,
    source_commit,
    github_run_number: run_number,
    github_run_id: run_id,
    github_run_attempt: run_attempt,
    prerelease,
    rust_targets: platform_names.map(
      (platform_name) => RELEASE_PLATFORMS[platform_name].target_triple,
    ),
  };
  await writeFile(
    path.join(output_root, RELEASE_BUILD_INFO_NAME),
    `${JSON.stringify(build_info, null, 2)}\n`,
    "utf8",
  );
  staged_names.add(RELEASE_BUILD_INFO_NAME);

  const checksum_lines = [];
  for (const file_name of [...staged_names].sort(compare_stable)) {
    checksum_lines.push(`${await sha256_file(path.join(output_root, file_name))}  ${file_name}`);
  }
  await writeFile(
    path.join(output_root, RELEASE_CHECKSUM_NAME),
    `${checksum_lines.join("\n")}\n`,
    "utf8",
  );
  const file_names = [...staged_names, RELEASE_CHECKSUM_NAME].sort(compare_stable);
  return {
    file_names,
    output_root,
    prerelease,
    run_attempt,
    run_id,
    run_number,
    source_commit,
    tag_name,
    version,
  };
}

export async function run_release_artifacts_command(args, dependencies = {}) {
  const [
    command,
    input_root,
    output_root,
    run_number,
    tag_name,
    source_commit,
    run_id,
    run_attempt,
  ] = args;
  const read_version = dependencies.read_project_version ?? read_project_version;
  const read_changelog = dependencies.read_changelog
    ?? (() => readFileSync(CHANGELOG_PATH, "utf8"));
  const stage_release = dependencies.stage_release_artifacts ?? stage_release_artifacts;
  const log = dependencies.log ?? ((message) => console.log(message));
  if (command === "verify" && args.length === 1) {
    const version = read_version();
    validate_release_changelog(read_changelog(), version);
    log(`Verified release changelog for Vofa-Ultra v${version}`);
    return { command, version };
  }
  if (command !== "stage"
    || args.length !== 8
    || !input_root
    || !output_root
    || !run_number
    || !tag_name
    || !source_commit
    || !run_id
    || !run_attempt) {
    fail(
      "Usage: release-artifacts.mjs verify | release-artifacts.mjs stage "
        + "<downloaded-artifact-root> <output-root> <run-number> <tag> <source-commit> "
        + "<run-id> <run-attempt>",
    );
  }
  const result = await stage_release({
    input_root,
    output_root,
    run_attempt,
    run_id,
    run_number,
    source_commit,
    tag_name,
  });
  log(
    `Staged ${result.file_names.length} verified assets for draft release ${result.tag_name} `
      + `in ${result.output_root}`,
  );
  return { command, result };
}

async function main() {
  await run_release_artifacts_command(process.argv.slice(2));
}

const is_main = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (is_main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
