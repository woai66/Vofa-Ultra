import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  extract_release_changelog,
  is_prerelease_version,
  parse_checksum_manifest,
  RELEASE_PLATFORMS,
  stage_release_artifacts,
  verify_checksum_directory,
} from "./release-artifacts.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_MANIFEST = JSON.parse(
  readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
);
const VERSION = PACKAGE_MANIFEST.version;
const RUN_NUMBER = "42";
const RUN_ID = "4242";
const RUN_ATTEMPT = "1";
const SOURCE_COMMIT = "a".repeat(40);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function supply_chain_names(target_triple) {
  return [
    "SUPPLY_CHAIN_SHA256SUMS",
    `THIRD_PARTY_NOTICES-${target_triple}.txt`,
    `vofa-ultra-${target_triple}.cdx.json`,
  ].sort();
}

function installer_names(platform_name) {
  if (platform_name === "linux") {
    return [
      `Vofa-Ultra_${VERSION}_amd64.AppImage`,
      `Vofa-Ultra_${VERSION}_amd64.deb`,
    ];
  }
  if (platform_name === "macos") {
    return [`Vofa-Ultra_${VERSION}_x64.dmg`];
  }
  return [
    `Vofa-Ultra_${VERSION}_x64-setup.exe`,
    `Vofa-Ultra_${VERSION}_x64_en-US.msi`,
  ];
}

function write_checksum_manifest(directory) {
  const file_names = readdirSync(directory).filter((file_name) => file_name !== "SHA256SUMS").sort();
  const lines = file_names.map((file_name) => (
    `${sha256(readFileSync(path.join(directory, file_name)))}  ${file_name}`
  ));
  writeFileSync(path.join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function create_download_tree(
  input_root,
  run_number = RUN_NUMBER,
  run_attempt = RUN_ATTEMPT,
) {
  mkdirSync(input_root, { recursive: true });
  for (const [platform_name, platform] of Object.entries(RELEASE_PLATFORMS)) {
    const artifact_directory = path.join(
      input_root,
      `vofa-ultra-${platform_name}-${run_number}-${run_attempt}`,
    );
    mkdirSync(artifact_directory, { recursive: true });
    for (const installer_name of installer_names(platform_name)) {
      writeFileSync(
        path.join(artifact_directory, installer_name),
        `${platform_name}:${installer_name}\n`,
      );
    }
    writeFileSync(
      path.join(artifact_directory, "LICENSE"),
      readFileSync(path.join(PROJECT_ROOT, "LICENSE")),
    );
    writeFileSync(
      path.join(artifact_directory, `vofa-ultra-${platform.target_triple}.cdx.json`),
      `${JSON.stringify({ target: platform.target_triple })}\n`,
    );
    writeFileSync(
      path.join(artifact_directory, `THIRD_PARTY_NOTICES-${platform.target_triple}.txt`),
      `notices:${platform.target_triple}\n`,
    );
    writeFileSync(
      path.join(artifact_directory, "SUPPLY_CHAIN_SHA256SUMS"),
      `${"0".repeat(64)}  fixture\n`,
    );
    write_checksum_manifest(artifact_directory);
  }
}

async function verify_fixture_supply_chain(options) {
  const platform = RELEASE_PLATFORMS[options.platform_name];
  assert.equal(options.target_triple, platform.target_triple);
  return {
    file_names: supply_chain_names(platform.target_triple),
    output_directory: options.output_directory,
    platform_name: options.platform_name,
    target_triple: options.target_triple,
  };
}

test("parses only stable flat checksum manifests", () => {
  const first_hash = "0".repeat(64);
  const second_hash = "1".repeat(64);
  const parsed = parse_checksum_manifest(
    `${first_hash}  a.bin\n${second_hash}  b.bin\n`,
  );
  assert.deepEqual([...parsed], [["a.bin", first_hash], ["b.bin", second_hash]]);
  assert.throws(
    () => parse_checksum_manifest(`${first_hash}  ../outside\n`),
    /unsafe filename/,
  );
  assert.throws(
    () => parse_checksum_manifest(`${first_hash}  b.bin\n${second_hash}  a.bin\n`),
    /stable filename order/,
  );
  assert.throws(
    () => parse_checksum_manifest(`${first_hash}  SHA256SUMS\n`),
    /self-reference/,
  );
});

test("classifies release channels and extracts an exact categorized changelog section", () => {
  assert.equal(is_prerelease_version("0.9.0"), true);
  assert.equal(is_prerelease_version("1.0.0-rc.1"), true);
  assert.equal(is_prerelease_version("1.0.0"), false);

  const changelog = [
    "# Changes",
    "",
    "## [Unreleased]",
    "",
    "## [1.0.0-rc.1] - 2026-08-24",
    "",
    "### Added",
    "",
    "- Candidate feature.",
    "",
    "## [0.9.0] - 2026-08-01",
    "",
    "- Previous feature.",
    "",
  ].join("\r\n");
  assert.equal(
    extract_release_changelog(changelog, "1.0.0-rc.1"),
    "## [1.0.0-rc.1] - 2026-08-24\n\n### Added\n\n- Candidate feature.\n",
  );
  assert.throws(
    () => extract_release_changelog(changelog, "2.0.0"),
    /exactly one release section/,
  );
  assert.throws(
    () => extract_release_changelog("## [1.0.0]\n\nNo categorized entries.\n", "1.0.0"),
    /categorized entries/,
  );
});

test("stages deterministic flat assets from exactly three verified platforms", async () => {
  const temporary_root = mkdtempSync(path.join(tmpdir(), "vofa-ultra-release-stage-test-"));
  try {
    const input_root = path.join(temporary_root, "downloaded");
    const first_output = path.join(temporary_root, "release-a");
    const second_output = path.join(temporary_root, "release-b");
    create_download_tree(input_root);

    const first = await stage_release_artifacts({
      input_root,
      output_root: first_output,
      run_attempt: RUN_ATTEMPT,
      run_id: RUN_ID,
      run_number: RUN_NUMBER,
      source_commit: SOURCE_COMMIT,
      tag_name: `v${VERSION}`,
      verify_supply_chain: verify_fixture_supply_chain,
    });
    const second = await stage_release_artifacts({
      input_root,
      output_root: second_output,
      run_attempt: RUN_ATTEMPT,
      run_id: RUN_ID,
      run_number: RUN_NUMBER,
      source_commit: SOURCE_COMMIT,
      tag_name: `v${VERSION}`,
      verify_supply_chain: verify_fixture_supply_chain,
    });

    assert.equal(first.file_names.length, 18);
    assert.deepEqual(first.file_names, second.file_names);
    assert.equal(first.prerelease, is_prerelease_version(VERSION));
    assert.equal(first.file_names.includes("SUPPLY_CHAIN_SHA256SUMS"), false);
    assert.equal(first.file_names.includes("RELEASE_CHANGELOG.md"), true);
    assert.equal(first.file_names.includes("RELEASE_BUILD_INFO.json"), true);
    const build_info = JSON.parse(
      readFileSync(path.join(first_output, "RELEASE_BUILD_INFO.json"), "utf8"),
    );
    assert.equal(build_info.source_commit, SOURCE_COMMIT);
    assert.equal(build_info.github_run_number, RUN_NUMBER);
    assert.equal(build_info.github_run_id, RUN_ID);
    assert.equal(build_info.github_run_attempt, RUN_ATTEMPT);
    assert.equal(build_info.tag_name, `v${VERSION}`);
    assert.equal(build_info.prerelease, is_prerelease_version(VERSION));
    assert.match(
      readFileSync(path.join(first_output, "RELEASE_CHANGELOG.md"), "utf8"),
      new RegExp(`^## \\[${VERSION.replaceAll(".", "\\.")}\\]`, "u"),
    );
    for (const platform of Object.values(RELEASE_PLATFORMS)) {
      assert.equal(
        first.file_names.includes(`SUPPLY_CHAIN_SHA256SUMS-${platform.target_triple}`),
        true,
      );
    }
    await verify_checksum_directory(first_output);
    for (const file_name of first.file_names) {
      assert.equal(
        readFileSync(path.join(first_output, file_name)).equals(
          readFileSync(path.join(second_output, file_name)),
        ),
        true,
      );
    }
  } finally {
    rmSync(temporary_root, { recursive: true, force: true });
  }
});

test("rejects source artifacts that do not match their checksum manifest", async () => {
  const temporary_root = mkdtempSync(path.join(tmpdir(), "vofa-ultra-release-tamper-test-"));
  try {
    const input_root = path.join(temporary_root, "downloaded");
    create_download_tree(input_root);
    const installer_path = path.join(
      input_root,
      `vofa-ultra-windows-${RUN_NUMBER}-${RUN_ATTEMPT}`,
      `Vofa-Ultra_${VERSION}_x64_en-US.msi`,
    );
    writeFileSync(installer_path, "tampered\n");
    await assert.rejects(
      stage_release_artifacts({
        input_root,
        output_root: path.join(temporary_root, "release"),
        run_attempt: RUN_ATTEMPT,
        run_id: RUN_ID,
        run_number: RUN_NUMBER,
        source_commit: SOURCE_COMMIT,
        tag_name: `v${VERSION}`,
        verify_supply_chain: verify_fixture_supply_chain,
      }),
      /Checksum mismatch/,
    );
  } finally {
    rmSync(temporary_root, { recursive: true, force: true });
  }
});

test("rejects stale runs, reused outputs, wrong tags, and changed project licenses", async () => {
  const temporary_root = mkdtempSync(path.join(tmpdir(), "vofa-ultra-release-boundary-test-"));
  try {
    const input_root = path.join(temporary_root, "downloaded");
    create_download_tree(input_root);
    await assert.rejects(
      stage_release_artifacts({
        input_root,
        output_root: path.join(temporary_root, "wrong-tag"),
        run_attempt: RUN_ATTEMPT,
        run_id: RUN_ID,
        run_number: RUN_NUMBER,
        source_commit: SOURCE_COMMIT,
        tag_name: "v9.9.9",
        verify_supply_chain: verify_fixture_supply_chain,
      }),
      /Release tag must be/,
    );
    await assert.rejects(
      stage_release_artifacts({
        input_root,
        output_root: path.join(temporary_root, "stale-run"),
        run_attempt: RUN_ATTEMPT,
        run_id: RUN_ID,
        run_number: "43",
        source_commit: SOURCE_COMMIT,
        tag_name: `v${VERSION}`,
        verify_supply_chain: verify_fixture_supply_chain,
      }),
      /exactly the three current-run platform artifacts/,
    );
    await assert.rejects(
      stage_release_artifacts({
        input_root,
        output_root: path.join(temporary_root, "stale-attempt"),
        run_attempt: "2",
        run_id: RUN_ID,
        run_number: RUN_NUMBER,
        source_commit: SOURCE_COMMIT,
        tag_name: `v${VERSION}`,
        verify_supply_chain: verify_fixture_supply_chain,
      }),
      /exactly the three current-run platform artifacts/,
    );
    await assert.rejects(
      stage_release_artifacts({
        input_root,
        output_root: path.join(temporary_root, "wrong-source"),
        run_attempt: RUN_ATTEMPT,
        run_id: RUN_ID,
        run_number: RUN_NUMBER,
        source_commit: "not-a-commit",
        tag_name: `v${VERSION}`,
        verify_supply_chain: verify_fixture_supply_chain,
      }),
      /source commit is invalid/,
    );

    const reused_output = path.join(temporary_root, "reused-output");
    mkdirSync(reused_output);
    writeFileSync(path.join(reused_output, "old-asset"), "stale\n");
    await assert.rejects(
      stage_release_artifacts({
        input_root,
        output_root: reused_output,
        run_attempt: RUN_ATTEMPT,
        run_id: RUN_ID,
        run_number: RUN_NUMBER,
        source_commit: SOURCE_COMMIT,
        tag_name: `v${VERSION}`,
        verify_supply_chain: verify_fixture_supply_chain,
      }),
      /output directory is not empty/,
    );

    const linux_directory = path.join(
      input_root,
      `vofa-ultra-linux-${RUN_NUMBER}-${RUN_ATTEMPT}`,
    );
    writeFileSync(path.join(linux_directory, "LICENSE"), "different license\n");
    write_checksum_manifest(linux_directory);
    await assert.rejects(
      stage_release_artifacts({
        input_root,
        output_root: path.join(temporary_root, "wrong-license"),
        run_attempt: RUN_ATTEMPT,
        run_id: RUN_ID,
        run_number: RUN_NUMBER,
        source_commit: SOURCE_COMMIT,
        tag_name: `v${VERSION}`,
        verify_supply_chain: verify_fixture_supply_chain,
      }),
      /LICENSE does not match/,
    );
  } finally {
    rmSync(temporary_root, { recursive: true, force: true });
  }
});
