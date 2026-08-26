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
  BUILD_ENVIRONMENT_MAX_BYTES,
  BUILD_PLATFORMS,
  LINUX_BUILD_PACKAGES,
  build_environment_file_name,
  serialize_build_environment,
} from "./package-artifacts.mjs";
import {
  extract_release_changelog,
  is_prerelease_version,
  parse_checksum_manifest,
  RELEASE_PLATFORMS,
  run_release_artifacts_command,
  stage_release_artifacts,
  validate_release_changelog,
  verify_checksum_directory,
} from "./release-artifacts.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_MANIFEST = JSON.parse(
  readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
);
const VERSION = PACKAGE_MANIFEST.version;
const READY_CHANGELOG = [
  "# Changes",
  "",
  "## [Unreleased]",
  "",
  `## [${VERSION}] - 2026-08-25`,
  "",
  "### Added",
  "",
  "- Release fixture.",
  "",
].join("\n");
const RUN_NUMBER = "42";
const RUN_ID = "4242";
const RUN_ATTEMPT = "1";
const SOURCE_COMMIT = "a".repeat(40);
const CARGO_COMMIT = "b".repeat(40);
const RUSTC_COMMIT = "c".repeat(40);

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

function build_environment_record(platform_name) {
  const platform = RELEASE_PLATFORMS[platform_name];
  return {
    schema_version: 1,
    project: "vofa-ultra",
    version: VERSION,
    source_commit: SOURCE_COMMIT,
    source_dirty: false,
    platform: platform_name,
    rust_target: platform.target_triple,
    runner: {
      os: BUILD_PLATFORMS[platform_name].runner_os,
      arch: "X64",
      environment: "github-hosted",
      image_os: platform_name === "linux" ? "ubuntu22" : `${platform_name}15`,
      image_version: "20260818.1.0",
    },
    toolchain: {
      node: "22.23.2",
      pnpm: "11.7.0",
      tauri_cli: "2.11.4",
      cargo: {
        release: "1.98.0",
        commit_hash: CARGO_COMMIT,
        commit_date: "2026-08-05",
        host: platform.target_triple,
      },
      rustc: {
        release: "1.98.0",
        commit_hash: RUSTC_COMMIT,
        commit_date: "2026-08-18",
        host: platform.target_triple,
        llvm_version: "22.1.8",
      },
    },
    declared_system_packages: platform_name === "linux"
      ? LINUX_BUILD_PACKAGES.map((name) => ({
        name,
        architecture: "amd64",
        version: "1.0.0-1ubuntu1",
      }))
      : [],
  };
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
    writeFileSync(
      path.join(artifact_directory, build_environment_file_name(platform.target_triple)),
      serialize_build_environment(build_environment_record(platform_name)),
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

function stage_fixture(options) {
  return stage_release_artifacts({
    changelog_text: READY_CHANGELOG,
    ...options,
  });
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

test("classifies release channels and validates an exact ready changelog section", () => {
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
  assert.equal(
    validate_release_changelog(changelog, "1.0.0-rc.1"),
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
  assert.throws(
    () => validate_release_changelog(
      changelog.replace(
        "## [Unreleased]\r\n\r\n",
        "## [Unreleased]\r\n\r\n### Added\r\n\r\n- Pending feature.\r\n\r\n",
      ),
      "1.0.0-rc.1",
    ),
    /Unreleased section must be empty/,
  );
  assert.throws(
    () => validate_release_changelog(
      "## [1.0.0]\n\n### Added\n\n- Released feature.\n",
      "1.0.0",
    ),
    /exactly one Unreleased section/,
  );
  assert.throws(
    () => validate_release_changelog(
      changelog.replace(
        "## [1.0.0-rc.1] - 2026-08-24",
        "## [1.1.0] - 2026-08-25\n\n### Added\n\n- Newer feature.\n\n"
          + "## [1.0.0-rc.1] - 2026-08-24",
      ),
      "1.0.0-rc.1",
    ),
    /first release section after Unreleased must be 1\.0\.0-rc\.1/,
  );
  assert.throws(
    () => validate_release_changelog(
      changelog.replace(
        "## [1.0.0-rc.1] - 2026-08-24",
        "## Release notes\n\n## [1.0.0-rc.1] - 2026-08-24",
      ),
      "1.0.0-rc.1",
    ),
    /first release section after Unreleased must be 1\.0\.0-rc\.1/,
  );
});

test("dispatches release CLI commands with injected workspace dependencies", async () => {
  const logs = [];
  const stage_calls = [];
  const dependencies = {
    log: (message) => logs.push(message),
    read_changelog: () => READY_CHANGELOG,
    read_project_version: () => VERSION,
    stage_release_artifacts: async (options) => {
      stage_calls.push(options);
      return {
        file_names: ["candidate.bin"],
        output_root: options.output_root,
        tag_name: options.tag_name,
      };
    },
  };

  assert.deepEqual(
    await run_release_artifacts_command(["verify"], dependencies),
    { command: "verify", version: VERSION },
  );
  assert.equal(stage_calls.length, 0);
  assert.equal(logs[0], `Verified release changelog for Vofa-Ultra v${VERSION}`);

  const stage_args = [
    "stage",
    "downloaded",
    "release",
    RUN_NUMBER,
    `v${VERSION}`,
    SOURCE_COMMIT,
    RUN_ID,
    RUN_ATTEMPT,
  ];
  const dispatched = await run_release_artifacts_command(stage_args, dependencies);
  assert.equal(dispatched.command, "stage");
  assert.equal(dispatched.result.file_names.length, 1);
  assert.deepEqual(stage_calls, [{
    input_root: "downloaded",
    output_root: "release",
    run_attempt: RUN_ATTEMPT,
    run_id: RUN_ID,
    run_number: RUN_NUMBER,
    source_commit: SOURCE_COMMIT,
    tag_name: `v${VERSION}`,
  }]);
  assert.match(logs[1], /Staged 1 verified assets for draft release/);

  await assert.rejects(
    run_release_artifacts_command(["verify", "unexpected"], dependencies),
    /Usage: release-artifacts\.mjs verify/,
  );
  await assert.rejects(
    run_release_artifacts_command(stage_args.slice(0, -1), dependencies),
    /Usage: release-artifacts\.mjs verify/,
  );
  await assert.rejects(
    run_release_artifacts_command([...stage_args, "unexpected"], dependencies),
    /Usage: release-artifacts\.mjs verify/,
  );
});

test("stages deterministic flat assets from exactly three verified platforms", async () => {
  const temporary_root = mkdtempSync(path.join(tmpdir(), "vofa-ultra-release-stage-test-"));
  try {
    const input_root = path.join(temporary_root, "downloaded");
    const first_output = path.join(temporary_root, "release-a");
    const second_output = path.join(temporary_root, "release-b");
    create_download_tree(input_root);

    const first = await stage_fixture({
      input_root,
      output_root: first_output,
      run_attempt: RUN_ATTEMPT,
      run_id: RUN_ID,
      run_number: RUN_NUMBER,
      source_commit: SOURCE_COMMIT,
      tag_name: `v${VERSION}`,
      verify_supply_chain: verify_fixture_supply_chain,
    });
    const second = await stage_fixture({
      input_root,
      output_root: second_output,
      run_attempt: RUN_ATTEMPT,
      run_id: RUN_ID,
      run_number: RUN_NUMBER,
      source_commit: SOURCE_COMMIT,
      tag_name: `v${VERSION}`,
      verify_supply_chain: verify_fixture_supply_chain,
    });

    assert.equal(first.file_names.length, 21);
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
    const release_changelog = readFileSync(
      path.join(first_output, "RELEASE_CHANGELOG.md"),
      "utf8",
    );
    const version_pattern = new RegExp(
      `^## \\[${VERSION.replaceAll(".", "\\.")}\\]`,
      "u",
    );
    assert.match(release_changelog, version_pattern);
    assert.match(release_changelog, /- Release fixture\./);
    for (const platform of Object.values(RELEASE_PLATFORMS)) {
      assert.equal(
        first.file_names.includes(`SUPPLY_CHAIN_SHA256SUMS-${platform.target_triple}`),
        true,
      );
      assert.equal(
        first.file_names.includes(build_environment_file_name(platform.target_triple)),
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
      stage_fixture({
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

test("rejects semantically invalid build environments after checksum verification", async () => {
  const temporary_root = mkdtempSync(path.join(tmpdir(), "vofa-ultra-build-environment-test-"));
  try {
    const cases = [
      {
        name: "wrong-source",
        mutate: (record) => {
          record.source_commit = "d".repeat(40);
        },
        pattern: /source_commit does not match/,
      },
      {
        name: "wrong-target",
        mutate: (record) => {
          record.rust_target = "x86_64-pc-windows-msvc";
        },
        pattern: /target does not match/,
      },
      {
        name: "wrong-runner",
        mutate: (record) => {
          record.runner.os = "Windows";
        },
        pattern: /runner does not match/,
      },
      {
        name: "mismatched-toolchain",
        mutate: (record) => {
          record.toolchain.cargo.host = "aarch64-apple-darwin";
        },
        pattern: /Cargo and rustc must report the same release and host/,
      },
      {
        name: "unknown-field",
        mutate: (record) => {
          record.workspace = "/home/runner/work";
        },
        pattern: /fields or field order/,
      },
      {
        name: "oversized",
        mutate: () => {},
        render: () => `${JSON.stringify({
          padding: "x".repeat(BUILD_ENVIRONMENT_MAX_BYTES),
        })}\n`,
        pattern: /record is too large/,
      },
    ];

    for (const test_case of cases) {
      const input_root = path.join(temporary_root, `input-${test_case.name}`);
      create_download_tree(input_root);
      const linux_directory = path.join(
        input_root,
        `vofa-ultra-linux-${RUN_NUMBER}-${RUN_ATTEMPT}`,
      );
      const environment_path = path.join(
        linux_directory,
        build_environment_file_name(RELEASE_PLATFORMS.linux.target_triple),
      );
      const record = JSON.parse(readFileSync(environment_path, "utf8"));
      test_case.mutate(record);
      writeFileSync(
        environment_path,
        test_case.render ? test_case.render(record) : `${JSON.stringify(record, null, 2)}\n`,
      );
      write_checksum_manifest(linux_directory);
      await assert.rejects(
        stage_fixture({
          input_root,
          output_root: path.join(temporary_root, `output-${test_case.name}`),
          run_attempt: RUN_ATTEMPT,
          run_id: RUN_ID,
          run_number: RUN_NUMBER,
          source_commit: SOURCE_COMMIT,
          tag_name: `v${VERSION}`,
          verify_supply_chain: verify_fixture_supply_chain,
        }),
        test_case.pattern,
      );
    }

    const missing_root = path.join(temporary_root, "input-missing");
    create_download_tree(missing_root);
    const windows_directory = path.join(
      missing_root,
      `vofa-ultra-windows-${RUN_NUMBER}-${RUN_ATTEMPT}`,
    );
    rmSync(
      path.join(
        windows_directory,
        build_environment_file_name(RELEASE_PLATFORMS.windows.target_triple),
      ),
    );
    write_checksum_manifest(windows_directory);
    await assert.rejects(
      stage_fixture({
        input_root: missing_root,
        output_root: path.join(temporary_root, "output-missing"),
        run_attempt: RUN_ATTEMPT,
        run_id: RUN_ID,
        run_number: RUN_NUMBER,
        source_commit: SOURCE_COMMIT,
        tag_name: `v${VERSION}`,
        verify_supply_chain: verify_fixture_supply_chain,
      }),
      /Build environment record is missing|unexpected file/,
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
      stage_fixture({
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
      stage_fixture({
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
      stage_fixture({
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
      stage_fixture({
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
      stage_fixture({
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
      stage_fixture({
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
