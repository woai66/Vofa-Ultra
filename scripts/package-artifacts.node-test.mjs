import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parse_yaml } from "yaml";
import {
  BUILD_ENVIRONMENT_MAX_BYTES,
  BUILD_PLATFORMS,
  LINUX_BUILD_PACKAGES,
  PROJECT_RELEASE_COORDINATES,
  assert_no_local_paths_in_binary,
  build_environment_file_name,
  build_ci_environment,
  local_path_binary_needles,
  parse_and_validate_build_environment,
  parse_linux_build_packages,
  parse_verbose_tool_version,
  pnpm_version_from_user_agent,
  serialize_build_environment,
  validate_repository_metadata,
} from "./package-artifacts.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_COMMIT = "a".repeat(40);
const CARGO_COMMIT = "b".repeat(40);
const RUSTC_COMMIT = "c".repeat(40);
const ATTESTATION_ACTION =
  "actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a";

const CARGO_VERBOSE = [
  "cargo 1.98.0 (bbbbbbbbb 2026-08-05)",
  "release: 1.98.0",
  `commit-hash: ${CARGO_COMMIT}`,
  "commit-date: 2026-08-05",
  "host: x86_64-unknown-linux-gnu",
  "libgit2: 1.9.4 (sys:0.21.0 vendored)",
  "libcurl: 8.21.0-DEV",
  "os: Ubuntu 22.04 [64-bit]",
  "",
].join("\n");

const RUSTC_VERBOSE = [
  "rustc 1.98.0 (ccccccccc 2026-08-18)",
  "binary: rustc",
  `commit-hash: ${RUSTC_COMMIT}`,
  "commit-date: 2026-08-18",
  "host: x86_64-unknown-linux-gnu",
  "release: 1.98.0",
  "LLVM version: 22.1.8",
  "",
].join("\n");

function linux_packages() {
  const lines = [
    "patchelf\tamd64\t0.14.3-1",
    "libwebkit2gtk-4.1-dev\tamd64\t2.44.0-0ubuntu0.22.04.1",
    "librsvg2-dev\tamd64\t2.52.5+dfsg-3ubuntu0.2",
    "libayatana-appindicator3-dev\tamd64\t0.5.90-7ubuntu2",
  ];
  return parse_linux_build_packages(`${lines.join("\r\n")}\r\n`);
}

function build_record(platform_name = "linux") {
  const platform = BUILD_PLATFORMS[platform_name];
  const cargo = parse_verbose_tool_version(CARGO_VERBOSE, "cargo");
  const rustc = parse_verbose_tool_version(RUSTC_VERBOSE, "rustc");
  cargo.host = platform.runner_hosts.X64;
  rustc.host = platform.runner_hosts.X64;
  return {
    schema_version: 1,
    project: "vofa-ultra",
    version: "0.1.0",
    source_commit: SOURCE_COMMIT,
    source_dirty: false,
    platform: platform_name,
    rust_target: platform.target_triple,
    runner: {
      os: platform.runner_os,
      arch: "X64",
      environment: "github-hosted",
      image_os: platform_name === "linux" ? "ubuntu22" : `${platform_name}15`,
      image_version: "20260818.1.0",
    },
    toolchain: {
      node: "22.23.2",
      pnpm: "11.7.0",
      tauri_cli: "2.11.4",
      cargo,
      rustc,
    },
    declared_system_packages: platform_name === "linux" ? linux_packages() : [],
  };
}

function github_environment(platform_name = "linux") {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_SHA: SOURCE_COMMIT,
    RUNNER_ARCH: "X64",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: BUILD_PLATFORMS[platform_name].runner_os,
    ImageOS: platform_name === "linux" ? "ubuntu22" : `${platform_name}15`,
    ImageVersion: "20260818.1.0",
    GITHUB_WORKSPACE: "/home/runner/work/private-project",
    RUNNER_TEMP: "/home/runner/work/_temp/private-token",
    HOME: "/home/runner",
    USERPROFILE: "C:\\Users\\runneradmin",
  };
}

function tool_samples(platform_name = "linux") {
  return {
    node: "22.23.2",
    pnpm: "11.7.0",
    tauri_cli: "2.11.4",
    cargo_verbose: CARGO_VERBOSE,
    rustc_verbose: RUSTC_VERBOSE,
    linux_packages: platform_name === "linux"
      ? [
        "patchelf\tamd64\t0.14.3-1",
        "libwebkit2gtk-4.1-dev\tamd64\t2.44.0-0ubuntu0.22.04.1",
        "librsvg2-dev\tamd64\t2.52.5+dfsg-3ubuntu0.2",
        "libayatana-appindicator3-dev\tamd64\t0.5.90-7ubuntu2",
        "",
      ].join("\n")
      : null,
  };
}

function repository_metadata() {
  return {
    package_manifest: {
      repository: {
        type: "git",
        url: PROJECT_RELEASE_COORDINATES.npm_repository,
      },
      homepage: PROJECT_RELEASE_COORDINATES.homepage,
      bugs: { url: PROJECT_RELEASE_COORDINATES.issues },
    },
    tauri_config: { identifier: PROJECT_RELEASE_COORDINATES.tauri_identifier },
    cargo_package: {
      repository: PROJECT_RELEASE_COORDINATES.cargo_repository,
      homepage: PROJECT_RELEASE_COORDINATES.cargo_homepage,
    },
  };
}

test("accepts canonical public repository metadata", () => {
  const metadata = repository_metadata();
  assert.doesNotThrow(() => validate_repository_metadata(
    metadata.package_manifest,
    metadata.tauri_config,
    metadata.cargo_package,
  ));
});

test("rejects npm repository type, owner, or name drift", () => {
  for (const field_name of ["type", "url"]) {
    const metadata = repository_metadata();
    metadata.package_manifest.repository[field_name] = field_name === "type"
      ? "svn"
      : "https://github.com/example/Vofa-Ultra.git";
    assert.throws(
      () => validate_repository_metadata(
        metadata.package_manifest,
        metadata.tauri_config,
        metadata.cargo_package,
      ),
      field_name === "type" ? /package\.json repository\.type/ : /package\.json repository\.url/,
    );
  }
});

test("rejects npm homepage and issue tracker drift", () => {
  for (const field_name of ["homepage", "issues"]) {
    const metadata = repository_metadata();
    if (field_name === "homepage") {
      metadata.package_manifest.homepage = "https://github.com/woai66/other#readme";
    } else {
      metadata.package_manifest.bugs.url = "https://github.com/woai66/other/issues";
    }
    assert.throws(
      () => validate_repository_metadata(
        metadata.package_manifest,
        metadata.tauri_config,
        metadata.cargo_package,
      ),
      field_name === "homepage" ? /package\.json homepage/ : /package\.json bugs\.url/,
    );
  }
});

test("rejects Cargo repository and homepage drift", () => {
  for (const field_name of ["repository", "homepage"]) {
    const metadata = repository_metadata();
    metadata.cargo_package[field_name] = "https://github.com/woai66/other";
    assert.throws(
      () => validate_repository_metadata(
        metadata.package_manifest,
        metadata.tauri_config,
        metadata.cargo_package,
      ),
      field_name === "repository" ? /Cargo repository/ : /Cargo homepage/,
    );
  }
});

test("rejects Tauri identifier drift", () => {
  const metadata = repository_metadata();
  metadata.tauri_config.identifier = "io.github.example.vofaultra";
  assert.throws(
    () => validate_repository_metadata(
      metadata.package_manifest,
      metadata.tauri_config,
      metadata.cargo_package,
    ),
    /Tauri identifier/,
  );
});

test("serializes a deterministic canonical build environment without path leakage", () => {
  const record = build_record();
  const first = serialize_build_environment(record);
  const second = serialize_build_environment(structuredClone(record));
  assert.equal(first, second);
  assert.equal(first.endsWith("\n"), true);
  assert.equal(first.includes("\r"), false);
  assert.deepEqual(
    record.declared_system_packages.map((entry) => entry.name),
    [...LINUX_BUILD_PACKAGES],
  );
  assert.equal(first.includes("C:\\Users\\fixture"), false);
  assert.equal(first.includes("/home/runner/work"), false);
  assert.equal(
    build_environment_file_name(record.rust_target),
    `BUILD_ENVIRONMENT-${record.rust_target}.json`,
  );
  assert.deepEqual(
    parse_and_validate_build_environment(first, {
      platform: "linux",
      rust_target: record.rust_target,
      source_commit: SOURCE_COMMIT,
      source_dirty: false,
      version: "0.1.0",
    }),
    record,
  );
});

test("rejects UTF-8 and UTF-16LE local paths without exposing the path in errors", () => {
  const windows_path = "C:\\Users\\private-builder\\cargo home";
  const unix_path = "/home/private-builder/project root";
  const fixtures = [
    Buffer.from(`prefix ${windows_path} suffix`, "utf8"),
    Buffer.from(`prefix ${windows_path.replaceAll("\\", "/")} suffix`, "utf16le"),
    Buffer.from(`prefix ${unix_path} suffix`, "utf8"),
    Buffer.from(`prefix ${unix_path.replaceAll("/", "\\")} suffix`, "utf16le"),
  ];

  assert.equal(local_path_binary_needles([windows_path, unix_path]).length, 8);
  assert.doesNotThrow(() => {
    assert_no_local_paths_in_binary(Buffer.from("clean release executable"), [windows_path]);
  });
  for (const fixture of fixtures) {
    assert.throws(
      () => assert_no_local_paths_in_binary(fixture, [windows_path, unix_path]),
      (error) => {
        assert.match(error.message, /local project or Cargo path/);
        assert.equal(error.message.includes("private-builder"), false);
        return true;
      },
    );
  }
});

test("parses allowlisted Cargo, rustc, and Linux package fields", () => {
  assert.equal(pnpm_version_from_user_agent("pnpm/11.7.0 npm/? node/v22.23.2 win32 x64"), "11.7.0");
  assert.equal(pnpm_version_from_user_agent("npm/11.0.0 node/v22.23.2"), null);
  assert.throws(() => pnpm_version_from_user_agent("pnpm/C:\\tools"), /pnpm version is invalid/);
  assert.deepEqual(
    parse_verbose_tool_version(CARGO_VERBOSE.replaceAll("\n", "\r\n"), "cargo"),
    parse_verbose_tool_version(CARGO_VERBOSE, "cargo"),
  );
  assert.deepEqual(
    parse_verbose_tool_version(RUSTC_VERBOSE.replaceAll("\n", "\r\n"), "rustc"),
    parse_verbose_tool_version(RUSTC_VERBOSE, "rustc"),
  );
  assert.throws(
    () => parse_verbose_tool_version(CARGO_VERBOSE.replace("release: 1.98.0\n", ""), "cargo"),
    /missing release/,
  );
  assert.throws(
    () => parse_verbose_tool_version(
      CARGO_VERBOSE.replace("release: 1.98.0", "release: 1.98.0\nrelease: 1.98.0"),
      "cargo",
    ),
    /duplicate field/,
  );
  assert.throws(
    () => parse_verbose_tool_version(RUSTC_VERBOSE.replace("LLVM version: 22.1.8", "LLVM path: /tmp"), "rustc"),
    /unknown or duplicate field/,
  );
  assert.throws(
    () => parse_verbose_tool_version(
      RUSTC_VERBOSE
        .replace("2026-08-18", "2026-02-30")
        .replace("commit-date: 2026-08-18", "commit-date: 2026-02-30"),
      "rustc",
    ),
    /commit date is invalid/,
  );
  assert.throws(
    () => parse_linux_build_packages(
      "libwebkit2gtk-4.1-dev\tamd64\t2.44.0\nlibwebkit2gtk-4.1-dev\tamd64\t2.44.0\n",
    ),
    /duplicate package/,
  );
});

test("builds only an allowlisted clean GitHub environment from injected samples", () => {
  const text = build_ci_environment({
    environment: github_environment(),
    platform_name: "linux",
    source: { source_commit: SOURCE_COMMIT, source_dirty: false },
    target_triple: BUILD_PLATFORMS.linux.target_triple,
    tools: tool_samples(),
    version: "0.1.0",
  });
  assert.equal(text.includes("private-project"), false);
  assert.equal(text.includes("private-token"), false);
  assert.equal(text.includes("runneradmin"), false);

  const missing_image = github_environment();
  delete missing_image.ImageVersion;
  assert.throws(
    () => build_ci_environment({
      environment: missing_image,
      platform_name: "linux",
      source: { source_commit: SOURCE_COMMIT, source_dirty: false },
      target_triple: BUILD_PLATFORMS.linux.target_triple,
      tools: tool_samples(),
      version: "0.1.0",
    }),
    /missing ImageVersion/,
  );

  for (const source of [
    { source_commit: "d".repeat(40), source_dirty: false },
    { source_commit: SOURCE_COMMIT, source_dirty: true },
  ]) {
    assert.throws(
      () => build_ci_environment({
        environment: github_environment(),
        platform_name: "linux",
        source,
        target_triple: BUILD_PLATFORMS.linux.target_triple,
        tools: tool_samples(),
        version: "0.1.0",
      }),
      /does not match GITHUB_SHA|must be clean/,
    );
  }
});

test("rejects mismatched targets, dirty sources, paths, and platform package drift", () => {
  const wrong_target = build_record("windows");
  wrong_target.rust_target = "x86_64-unknown-linux-gnu";
  assert.throws(() => serialize_build_environment(wrong_target), /target does not match/);

  const path_version = build_record("windows");
  path_version.toolchain.tauri_cli = "C:\\tools\\tauri.exe";
  assert.throws(() => serialize_build_environment(path_version), /Tauri CLI version is invalid/);

  const mismatched_toolchain = build_record("windows");
  mismatched_toolchain.toolchain.cargo.host = "aarch64-apple-darwin";
  assert.throws(
    () => serialize_build_environment(mismatched_toolchain),
    /Cargo and rustc must report the same release and host/,
  );

  const wrong_host = build_record("windows");
  wrong_host.toolchain.cargo.host = "x86_64-unknown-linux-gnu";
  wrong_host.toolchain.rustc.host = "x86_64-unknown-linux-gnu";
  assert.throws(
    () => serialize_build_environment(wrong_host),
    /toolchain host does not match windows runner/,
  );

  const non_linux_packages = build_record("macos");
  non_linux_packages.declared_system_packages = linux_packages();
  assert.throws(() => serialize_build_environment(non_linux_packages), /do not match macos/);

  const dirty = serialize_build_environment({ ...build_record("windows"), source_dirty: true });
  assert.throws(
    () => parse_and_validate_build_environment(dirty, { source_dirty: false }),
    /source_dirty does not match/,
  );
});

test("rejects non-canonical, duplicate, reordered, and extended JSON", () => {
  const canonical = serialize_build_environment(build_record("windows"));
  assert.throws(
    () => parse_and_validate_build_environment(canonical.replaceAll("\n", "\r\n")),
    /canonical JSON with LF/,
  );
  assert.throws(
    () => parse_and_validate_build_environment(`\ufeff${canonical}`),
    /canonical JSON with LF/,
  );
  assert.throws(
    () => parse_and_validate_build_environment(
      canonical.replace(
        '  "project": "vofa-ultra",',
        '  "project": "vofa-ultra",\n  "project": "vofa-ultra",',
      ),
    ),
    /not canonical/,
  );
  assert.throws(
    () => parse_and_validate_build_environment(
      canonical.replace(
        '  "schema_version": 1,\n  "project": "vofa-ultra",',
        '  "project": "vofa-ultra",\n  "schema_version": 1,',
      ),
    ),
    /fields or field order/,
  );
  assert.throws(
    () => parse_and_validate_build_environment(
      canonical.replace('\n}', ',\n  "workspace": "/home/runner/work"\n}'),
    ),
    /fields or field order/,
  );
  assert.throws(
    () => parse_and_validate_build_environment(
      `${JSON.stringify({ padding: "x".repeat(BUILD_ENVIRONMENT_MAX_BYTES) })}\n`,
    ),
    /canonical JSON with LF/,
  );
});

test("runs feature branches once through pull requests", () => {
  const workflow = parse_yaml(
    readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", "ci.yml"), "utf8"),
  );
  assert.deepEqual(workflow.on.push, {
    branches: ["main"],
    tags: ["v*"],
  });
  assert.equal(workflow.on.pull_request, null);
  assert.equal(workflow.on.workflow_dispatch, null);
});

test("pins tag-only provenance for platform builds and aggregate release assets", () => {
  const workflow = parse_yaml(
    readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", "ci.yml"), "utf8"),
  );
  const package_job = workflow.jobs.package;
  assert.deepEqual(package_job.permissions, {
    attestations: "write",
    contents: "read",
    "id-token": "write",
  });
  const tauri_build_steps = package_job.steps.filter(
    (step) => step.run?.trim().startsWith("pnpm tauri build"),
  );
  assert.equal(tauri_build_steps.length, 1);
  const collect_index = package_job.steps.findIndex((step) => step.run?.includes("package:collect"));
  const attest_index = package_job.steps.findIndex((step) => step.uses === ATTESTATION_ACTION);
  const upload_index = package_job.steps.findIndex(
    (step) => step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(collect_index < attest_index && attest_index < upload_index, true);
  assert.equal(package_job.steps[attest_index].if, "startsWith(github.ref, 'refs/tags/v')");
  assert.equal(
    package_job.steps[attest_index].with["subject-path"],
    "artifacts/${{ matrix.platform }}/*",
  );

  const release_job = workflow.jobs["release-draft"];
  assert.deepEqual(release_job.needs, ["package", "performance"]);
  assert.equal(release_job.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.deepEqual(release_job.permissions, {
    actions: "read",
    attestations: "write",
    contents: "write",
    "id-token": "write",
  });
  const stage_index = release_job.steps.findIndex((step) => step.run?.includes("release:stage"));
  const preflight_index = release_job.steps.findIndex(
    (step) => step.name === "Preflight aggregate provenance",
  );
  const release_attest_index = release_job.steps.findIndex((step) => step.uses === ATTESTATION_ACTION);
  const create_index = release_job.steps.findIndex((step) => step.run?.includes("gh release create"));
  assert.equal(
    stage_index < preflight_index
      && preflight_index < release_attest_index
      && release_attest_index < create_index,
    true,
  );
  assert.match(release_job.steps[preflight_index].run, /resolve_remote_tag_commit/);
  assert.match(release_job.steps[preflight_index].run, /releases\/tags/);
  assert.match(release_job.steps[preflight_index].run, /HTTP 404/);
  assert.equal(release_job.steps[release_attest_index].with["subject-path"], "release-assets/*");
});
