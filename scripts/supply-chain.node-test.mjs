import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  build_cyclonedx_bom,
  cargo_metadata_arguments,
  collect_cargo_runtime_graph,
  collect_npm_runtime_graph,
  normalize_license_expression,
  render_third_party_notices,
  select_approved_license,
  validate_cyclonedx_bom,
  validate_cyclonedx_schema,
} from "./supply-chain.mjs";
import {
  bundle_filename_has_version,
  bundle_root_for_target,
  has_parent,
} from "./package-artifacts.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY = JSON.parse(
  readFileSync(path.join(PROJECT_ROOT, "supply-chain-policy.json"), "utf8"),
);

function npm_manifest(name, version, license = "MIT") {
  return {
    name,
    version,
    license,
    description: `${name} fixture`,
    repository: `https://example.test/${name}`,
  };
}

function npm_fixture_options(manifests, unavailable_snapshots = new Set()) {
  const directories = new Map();
  return {
    resolve_package_directory({ snapshot_key, required }) {
      if (unavailable_snapshots.has(snapshot_key)) {
        if (required) {
          throw new Error(`required fixture is missing: ${snapshot_key}`);
        }
        return null;
      }
      const directory = path.join("C:\\virtual-npm", encodeURIComponent(snapshot_key));
      directories.set(directory, snapshot_key);
      return directory;
    },
    read_package_manifest(directory) {
      const snapshot_key = directories.get(directory);
      const manifest = manifests[snapshot_key];
      if (!manifest) {
        throw new Error(`fixture manifest is missing: ${snapshot_key}`);
      }
      return manifest;
    },
  };
}

function cargo_package(id, name, version, license = "MIT") {
  return {
    id,
    name,
    version,
    license,
    license_file: null,
    manifest_path: path.join(PROJECT_ROOT, "fixtures", name, "Cargo.toml"),
    source: "registry+https://github.com/rust-lang/crates.io-index",
    description: null,
    homepage: null,
    repository: `https://example.test/${name}`,
  };
}

function cargo_dep(package_id, kind = null) {
  return {
    name: package_id,
    pkg: package_id,
    dep_kinds: [{ kind, target: null }],
  };
}

test("normalizes reviewed legacy Cargo license aliases", () => {
  assert.equal(
    normalize_license_expression("MIT/Apache-2.0", POLICY),
    "MIT OR Apache-2.0",
  );
});

test("allows locked Cargo metadata to download a clean dependency cache", () => {
  assert.deepEqual(
    cargo_metadata_arguments("x86_64-unknown-linux-gnu"),
    [
      "metadata",
      "--locked",
      "--filter-platform",
      "x86_64-unknown-linux-gnu",
      "--format-version",
      "1",
      "--manifest-path",
      path.join(PROJECT_ROOT, "src-tauri", "Cargo.toml"),
    ],
  );
});

test("selects an approved SPDX branch and rejects unacceptable expressions", () => {
  assert.deepEqual(select_approved_license("MIT OR GPL-3.0-only", POLICY), {
    expression: "MIT OR GPL-3.0-only",
    licenses: ["MIT"],
    exceptions: [],
  });
  assert.deepEqual(
    select_approved_license("Apache-2.0 WITH LLVM-exception OR MIT", POLICY),
    {
      expression: "Apache-2.0 WITH LLVM-exception OR MIT",
      licenses: ["MIT"],
      exceptions: [],
    },
  );
  assert.throws(
    () => select_approved_license("GPL-3.0-only", POLICY),
    /No approved license choice/,
  );
  assert.throws(
    () => select_approved_license("MIT OR made-up", POLICY),
    /Invalid SPDX license expression/,
  );
});

test("collects the lockfile npm production graph with transitive dependency edges", () => {
  const lockfile = {
    lockfileVersion: "9.0",
    importers: {
      ".": {
        dependencies: {
          react: { specifier: "^19.1.1", version: "19.2.8" },
        },
      },
    },
    packages: {
      "react@19.2.8": { resolution: { integrity: "sha512-react" } },
      "scheduler@0.27.0": { resolution: { integrity: "sha512-scheduler" } },
    },
    snapshots: {
      "react@19.2.8": { dependencies: { scheduler: "0.27.0" } },
      "scheduler@0.27.0": {},
    },
  };
  const npm_graph = collect_npm_runtime_graph(
    lockfile,
    {
      dependencies: { react: "^19.1.1" },
    },
    POLICY,
    npm_fixture_options({
      "react@19.2.8": npm_manifest("react", "19.2.8"),
      "scheduler@0.27.0": npm_manifest("scheduler", "0.27.0"),
    }),
  );

  assert.equal(npm_graph.components.size, 2);
  assert.deepEqual([...npm_graph.root_dependencies], ["pkg:npm/react@19.2.8"]);
  assert.deepEqual(
    [...npm_graph.dependencies.get("pkg:npm/react@19.2.8")],
    ["pkg:npm/scheduler@0.27.0"],
  );
});

test("excludes installed optional peers while retaining real optional dependencies", () => {
  const zustand_snapshot = "zustand@5.0.15(@types/react@19.2.18)(react@19.2.8)";
  const lockfile = {
    lockfileVersion: "9.0",
    importers: {
      ".": {
        dependencies: {
          feature: { specifier: "1.0.0", version: "1.0.0" },
          react: { specifier: "^19.1.1", version: "19.2.8" },
          zustand: { specifier: "^5.0.8", version: "5.0.15(@types/react@19.2.18)(react@19.2.8)" },
        },
        devDependencies: {
          "@types/react": { specifier: "^19.1.12", version: "19.2.18" },
        },
      },
    },
    packages: {
      "@types/react@19.2.18": { resolution: { integrity: "sha512-types" } },
      "csstype@3.2.3": { resolution: { integrity: "sha512-csstype" } },
      "feature@1.0.0": { resolution: { integrity: "sha512-feature" } },
      "native-helper@2.0.0": { resolution: { integrity: "sha512-native" } },
      "react@19.2.8": { resolution: { integrity: "sha512-react" } },
      "zustand@5.0.15": {
        resolution: { integrity: "sha512-zustand" },
        peerDependencies: {
          "@types/react": ">=18.0.0",
          react: ">=18.0.0",
        },
        peerDependenciesMeta: {
          "@types/react": { optional: true },
          react: { optional: true },
        },
      },
    },
    snapshots: {
      "@types/react@19.2.18": { dependencies: { csstype: "3.2.3" } },
      "csstype@3.2.3": {},
      "feature@1.0.0": { optionalDependencies: { "native-helper": "2.0.0" } },
      "native-helper@2.0.0": {},
      "react@19.2.8": {},
      [zustand_snapshot]: {
        optionalDependencies: {
          "@types/react": "19.2.18",
          react: "19.2.8",
        },
      },
    },
  };
  const manifests = {
    "@types/react@19.2.18": npm_manifest("@types/react", "19.2.18"),
    "csstype@3.2.3": npm_manifest("csstype", "3.2.3"),
    "feature@1.0.0": npm_manifest("feature", "1.0.0"),
    "native-helper@2.0.0": npm_manifest("native-helper", "2.0.0"),
    "react@19.2.8": npm_manifest("react", "19.2.8"),
    [zustand_snapshot]: npm_manifest("zustand", "5.0.15"),
  };
  const package_manifest = {
    dependencies: {
      feature: "1.0.0",
      react: "^19.1.1",
      zustand: "^5.0.8",
    },
  };

  const full_install = collect_npm_runtime_graph(
    lockfile,
    package_manifest,
    POLICY,
    npm_fixture_options(manifests),
  );
  const production_install = collect_npm_runtime_graph(
    lockfile,
    package_manifest,
    POLICY,
    npm_fixture_options(
      manifests,
      new Set(["@types/react@19.2.18", "csstype@3.2.3"]),
    ),
  );
  const expected_refs = [
    "pkg:npm/feature@1.0.0",
    "pkg:npm/native-helper@2.0.0",
    "pkg:npm/react@19.2.8",
    "pkg:npm/zustand@5.0.15",
  ];
  assert.deepEqual([...full_install.components.keys()].sort(), expected_refs);
  assert.deepEqual([...production_install.components.keys()].sort(), expected_refs);
  assert.deepEqual([...full_install.dependencies.get("pkg:npm/zustand@5.0.15")], []);
});

test("fails closed for unsupported lockfiles, broken peers, and invalid installs", () => {
  const package_manifest = { dependencies: { example: "1.0.0" } };
  const base_lockfile = {
    lockfileVersion: "9.0",
    importers: {
      ".": {
        dependencies: {
          example: { specifier: "1.0.0", version: "1.0.0" },
        },
      },
    },
    packages: {
      "example@1.0.0": { resolution: { integrity: "sha512-example" } },
    },
    snapshots: {
      "example@1.0.0": {},
    },
  };
  const manifests = {
    "example@1.0.0": npm_manifest("example", "1.0.0"),
  };

  assert.throws(
    () => collect_npm_runtime_graph(
      { ...base_lockfile, lockfileVersion: "8.0" },
      package_manifest,
      POLICY,
      npm_fixture_options(manifests),
    ),
    /must use lockfileVersion 9\.0/,
  );
  assert.throws(
    () => collect_npm_runtime_graph(
      base_lockfile,
      { dependencies: { example: "^1.0.0" } },
      POLICY,
      npm_fixture_options(manifests),
    ),
    /specifier differs for example/,
  );
  assert.throws(
    () => collect_npm_runtime_graph(
      base_lockfile,
      package_manifest,
      POLICY,
      npm_fixture_options(manifests, new Set(["example@1.0.0"])),
    ),
    /required fixture is missing/,
  );
  assert.throws(
    () => collect_npm_runtime_graph(
      base_lockfile,
      package_manifest,
      POLICY,
      npm_fixture_options({
        "example@1.0.0": npm_manifest("example", "2.0.0"),
      }),
    ),
    /Installed npm manifest does not match lockfile/,
  );

  const broken_snapshot = "example@1.0.0(peer@2.0.0";
  assert.throws(
    () => collect_npm_runtime_graph(
      {
        ...base_lockfile,
        importers: {
          ".": {
            dependencies: {
              example: { specifier: "1.0.0", version: "1.0.0(peer@2.0.0" },
            },
          },
        },
        snapshots: { [broken_snapshot]: {} },
      },
      package_manifest,
      POLICY,
      npm_fixture_options({ [broken_snapshot]: npm_manifest("example", "1.0.0") }),
    ),
    /Unbalanced pnpm peer suffix/,
  );
});

test("merges dependency edges from multiple peer contexts of one npm version", () => {
  const shared_a = "shared@1.0.0(peer@1.0.0)";
  const shared_b = "shared@1.0.0(peer@2.0.0)";
  const lockfile = {
    lockfileVersion: "9.0",
    importers: {
      ".": {
        dependencies: {
          "entry-a": { specifier: "1.0.0", version: "1.0.0" },
          "entry-b": { specifier: "1.0.0", version: "1.0.0" },
        },
      },
    },
    packages: {
      "entry-a@1.0.0": { resolution: { integrity: "sha512-entry-a" } },
      "entry-b@1.0.0": { resolution: { integrity: "sha512-entry-b" } },
      "leaf-a@1.0.0": { resolution: { integrity: "sha512-leaf-a" } },
      "leaf-b@1.0.0": { resolution: { integrity: "sha512-leaf-b" } },
      "shared@1.0.0": { resolution: { integrity: "sha512-shared" } },
    },
    snapshots: {
      "entry-a@1.0.0": { dependencies: { shared: "1.0.0(peer@1.0.0)" } },
      "entry-b@1.0.0": { dependencies: { shared: "1.0.0(peer@2.0.0)" } },
      "leaf-a@1.0.0": {},
      "leaf-b@1.0.0": {},
      [shared_a]: { dependencies: { "leaf-a": "1.0.0" } },
      [shared_b]: { dependencies: { "leaf-b": "1.0.0" } },
    },
  };
  const manifests = Object.fromEntries([
    ["entry-a@1.0.0", npm_manifest("entry-a", "1.0.0")],
    ["entry-b@1.0.0", npm_manifest("entry-b", "1.0.0")],
    ["leaf-a@1.0.0", npm_manifest("leaf-a", "1.0.0")],
    ["leaf-b@1.0.0", npm_manifest("leaf-b", "1.0.0")],
    [shared_a, npm_manifest("shared", "1.0.0")],
    [shared_b, npm_manifest("shared", "1.0.0")],
  ]);
  const graph = collect_npm_runtime_graph(
    lockfile,
    { dependencies: { "entry-a": "1.0.0", "entry-b": "1.0.0" } },
    POLICY,
    npm_fixture_options(manifests),
  );

  assert.equal(graph.components.size, 5);
  assert.deepEqual(
    [...graph.dependencies.get("pkg:npm/shared@1.0.0")].sort(),
    ["pkg:npm/leaf-a@1.0.0", "pkg:npm/leaf-b@1.0.0"],
  );
});

test("collects only normal Cargo dependencies from a filtered target graph", () => {
  const root_id = "root@0.1.0";
  const runtime_id = "runtime@1.0.0";
  const nested_id = "nested@2.0.0";
  const build_id = "build-only@3.0.0";
  const cargo_graph = collect_cargo_runtime_graph(
    {
      packages: [
        cargo_package(root_id, "vofa-ultra", "0.1.0"),
        cargo_package(runtime_id, "runtime", "1.0.0"),
        cargo_package(nested_id, "nested", "2.0.0"),
        cargo_package(build_id, "build-only", "3.0.0"),
      ],
      resolve: {
        root: root_id,
        nodes: [
          {
            id: root_id,
            deps: [cargo_dep(runtime_id), cargo_dep(build_id, "build")],
          },
          { id: runtime_id, deps: [cargo_dep(nested_id)] },
          { id: nested_id, deps: [] },
          { id: build_id, deps: [] },
        ],
      },
    },
    POLICY,
  );

  assert.equal(cargo_graph.components.size, 2);
  assert.equal(cargo_graph.components.has("pkg:cargo/build-only@3.0.0"), false);
  assert.deepEqual([...cargo_graph.root_dependencies], ["pkg:cargo/runtime@1.0.0"]);
  assert.deepEqual(
    [...cargo_graph.dependencies.get("pkg:cargo/runtime@1.0.0")],
    ["pkg:cargo/nested@2.0.0"],
  );
});

test("builds deterministic CycloneDX 1.6 with a complete dependency table", async () => {
  const component = {
    ecosystem: "npm",
    group: null,
    name: "react",
    display_name: "react",
    version: "19.2.8",
    purl: "pkg:npm/react@19.2.8",
    license: select_approved_license("MIT", POLICY),
    homepage: "https://react.dev/",
    repository: null,
    distribution: null,
    description: "React",
    package_directory: "C:\\local-only",
    license_file: null,
  };
  const input = {
    project_name: "vofa-ultra",
    project_version: "0.1.0",
    project_license: select_approved_license("MIT", POLICY),
    target_triple: "x86_64-pc-windows-msvc",
    graph: {
      components: new Map([[component.purl, component]]),
      dependencies: new Map([[component.purl, new Set()]]),
      root_dependencies: new Set([component.purl]),
    },
  };

  const first = build_cyclonedx_bom(input);
  const second = build_cyclonedx_bom(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.doesNotThrow(() => validate_cyclonedx_bom(first));
  await validate_cyclonedx_schema(first);
  assert.equal(JSON.stringify(first).includes("local-only"), false);
  assert.equal(first.dependencies.length, 2);
});

test("collects packaged license and copyright text without leaking source paths", () => {
  const package_directory = mkdtempSync(path.join(tmpdir(), "vofa-ultra-notice-test-"));
  try {
    writeFileSync(
      path.join(package_directory, "LICENSE"),
      readFileSync(path.join(PROJECT_ROOT, "legal", "third-party", "SPDX-MIT.txt")),
    );
    writeFileSync(path.join(package_directory, "COPYRIGHT"), "Copyright Example Authors\n");
    const component = {
      ecosystem: "npm",
      display_name: "example",
      version: "1.0.0",
      purl: "pkg:npm/example@1.0.0",
      license: select_approved_license("MIT", POLICY),
      homepage: "https://example.test/example",
      repository: null,
      distribution: null,
      package_directory,
      license_file: null,
    };
    const notices = render_third_party_notices(
      new Map([[component.purl, component]]),
      "x86_64-unknown-linux-gnu",
      POLICY,
    );

    assert.match(notices, /pkg:npm\/example@1\.0\.0/);
    assert.match(notices, /Permission is hereby granted, free of charge/);
    assert.match(notices, /Copyright Example Authors/);
    assert.equal(notices.includes(package_directory), false);
  } finally {
    rmSync(package_directory, { recursive: true, force: true });
  }
});

test("fails closed without license terms and uses exact reviewed overrides", () => {
  const package_directory = mkdtempSync(path.join(tmpdir(), "vofa-ultra-override-test-"));
  try {
    const unreviewed_component = {
      ecosystem: "npm",
      display_name: "unreviewed",
      version: "1.0.0",
      purl: "pkg:npm/unreviewed@1.0.0",
      license: select_approved_license("MIT", POLICY),
      homepage: null,
      repository: null,
      distribution: null,
      package_directory,
      license_file: null,
    };
    assert.throws(
      () => render_third_party_notices(
        new Map([[unreviewed_component.purl, unreviewed_component]]),
        "x86_64-pc-windows-msvc",
        POLICY,
      ),
      /no verified terms for an approved license choice/,
    );

    const reviewed_component = {
      ...unreviewed_component,
      ecosystem: "cargo",
      display_name: "selectors",
      version: "0.36.1",
      purl: "pkg:cargo/selectors@0.36.1",
      license: select_approved_license("MPL-2.0", POLICY),
    };
    const notices = render_third_party_notices(
      new Map([[reviewed_component.purl, reviewed_component]]),
      "x86_64-pc-windows-msvc",
      POLICY,
    );
    assert.match(notices, /COMPONENTS USING REVIEWED NOTICE OVERRIDES/);
    assert.match(notices, /Mozilla Public License Version 2\.0/);
    assert.match(notices, /pkg:cargo\/selectors@0\.36\.1/);
  } finally {
    rmSync(package_directory, { recursive: true, force: true });
  }
});

test("binds an OR choice to full terms and rejects license metadata as terms", () => {
  const package_directory = mkdtempSync(path.join(tmpdir(), "vofa-ultra-evidence-test-"));
  try {
    writeFileSync(
      path.join(package_directory, "LICENSE"),
      readFileSync(
        path.join(
          PROJECT_ROOT,
          "legal",
          "third-party",
          "alloc-no-stdlib-BSD-3-Clause.txt",
        ),
      ),
    );
    const component = {
      ecosystem: "npm",
      display_name: "licensed-example",
      version: "1.0.0",
      purl: "pkg:npm/licensed-example@1.0.0",
      license: select_approved_license("MIT OR BSD-3-Clause", POLICY),
      homepage: null,
      repository: null,
      distribution: null,
      package_directory,
      license_file: null,
    };
    const notices = render_third_party_notices(
      new Map([[component.purl, component]]),
      "x86_64-pc-windows-msvc",
      POLICY,
    );
    assert.deepEqual(component.license.licenses, ["BSD-3-Clause"]);
    assert.match(notices, /MIT OR BSD-3-Clause\tBSD-3-Clause/);

    writeFileSync(
      path.join(package_directory, "LICENSE"),
      "SPDXVersion: SPDX-2.1\nPackageLicenseDeclared: MIT\n",
    );
    const metadata_only = {
      ...component,
      purl: "pkg:npm/metadata-only@1.0.0",
      display_name: "metadata-only",
      license: select_approved_license("MIT", POLICY),
    };
    assert.throws(
      () => render_third_party_notices(
        new Map([[metadata_only.purl, metadata_only]]),
        "x86_64-pc-windows-msvc",
        POLICY,
      ),
      /no verified terms for an approved license choice/,
    );
  } finally {
    rmSync(package_directory, { recursive: true, force: true });
  }
});

test("rejects truncated license text even when boundary markers are present", () => {
  const package_directory = mkdtempSync(path.join(tmpdir(), "vofa-ultra-truncated-license-test-"));
  const truncated_cases = [
    {
      name: "mit",
      expression: "MIT",
      text: [
        "Permission is hereby granted, free of charge, to deal in the Software without restriction.",
        "The above copyright notice and this permission notice shall be included.",
        "THE SOFTWARE IS PROVIDED AS-IS.",
        "Other dealings in the Software.",
      ].join("\n"),
    },
    {
      name: "apache",
      expression: "Apache-2.0",
      text: [
        "Apache License Version 2.0, January 2004",
        "Terms and Conditions for Use, Reproduction, and Distribution",
        "END OF TERMS AND CONDITIONS",
      ].join("\n"),
    },
    {
      name: "mpl",
      expression: "MPL-2.0",
      text: [
        "Mozilla Public License Version 2.0",
        "1. Definitions",
        "Defined by the Mozilla Public License, v. 2.0.",
      ].join("\n"),
    },
  ];

  try {
    for (const truncated of truncated_cases) {
      writeFileSync(path.join(package_directory, "LICENSE"), truncated.text);
      const component = {
        ecosystem: "npm",
        display_name: truncated.name,
        version: "1.0.0",
        purl: `pkg:npm/truncated-${truncated.name}@1.0.0`,
        license: select_approved_license(truncated.expression, POLICY),
        homepage: null,
        repository: null,
        distribution: null,
        package_directory,
        license_file: null,
      };
      assert.throws(
        () => render_third_party_notices(
          new Map([[component.purl, component]]),
          "x86_64-pc-windows-msvc",
          POLICY,
        ),
        /no verified terms for an approved license choice/,
      );
    }
  } finally {
    rmSync(package_directory, { recursive: true, force: true });
  }
});

test("isolates target-specific bundle roots and rejects paths from another target", () => {
  const default_root = bundle_root_for_target("x86_64-pc-windows-msvc", false);
  const x64_root = bundle_root_for_target("x86_64-pc-windows-msvc", true);
  const arm64_root = bundle_root_for_target("aarch64-pc-windows-msvc", true);
  const x64_installer = path.join(x64_root, "msi", "Vofa-Ultra_0.1.0_x64_en-US.msi");
  const arm64_installer = path.join(arm64_root, "msi", "Vofa-Ultra_0.1.0_arm64_en-US.msi");

  assert.notEqual(default_root, x64_root);
  assert.match(x64_root.replaceAll("\\", "/"), /target\/x86_64-pc-windows-msvc\/release\/bundle$/);
  assert.equal(has_parent(x64_root, x64_installer, "msi"), true);
  assert.equal(has_parent(x64_root, arm64_installer, "msi"), false);
  assert.throws(
    () => bundle_root_for_target("../outside", true),
    /Invalid Rust target for bundle directory/,
  );
  assert.equal(
    bundle_filename_has_version("Vofa-Ultra_0.1.0_x64-setup.exe", "0.1.0"),
    true,
  );
  assert.equal(
    bundle_filename_has_version("Vofa-Ultra_10.1.0_x64-setup.exe", "0.1.0"),
    false,
  );
});
