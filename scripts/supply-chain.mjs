#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { JsonStrictValidator } from "@cyclonedx/cyclonedx-library/Validation";
import { Version as CycloneDxVersion } from "@cyclonedx/cyclonedx-library/Spec";
import parse_spdx_expression from "spdx-expression-parse";
import { parse as parse_yaml } from "yaml";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = path.join(PROJECT_ROOT, "package.json");
const PNPM_LOCK_PATH = path.join(PROJECT_ROOT, "pnpm-lock.yaml");
const TAURI_CONFIG_PATH = path.join(PROJECT_ROOT, "src-tauri", "tauri.conf.json");
const CARGO_MANIFEST_PATH = path.join(PROJECT_ROOT, "src-tauri", "Cargo.toml");
const CARGO_LOCK_PATH = path.join(PROJECT_ROOT, "src-tauri", "Cargo.lock");
const POLICY_PATH = path.join(PROJECT_ROOT, "supply-chain-policy.json");
const LEGAL_NOTICE_ROOT = path.join(PROJECT_ROOT, "legal", "third-party");
const MAX_COMMAND_BUFFER = 64 * 1024 * 1024;
const MAX_NOTICE_FILE_BYTES = 512 * 1024;
const LICENSE_TERMS_FILE_PATTERN = /^(?:licen[cs]e|copying|unlicense)(?:[._-].*)?$/i;
const NOTICE_FILE_PATTERN = /^(?:notice|copyright|authors|patents)(?:[._-].*)?$/i;
const INPUT_FILES = [
  ["Cargo.lock", CARGO_LOCK_PATH],
  ["Cargo.toml", CARGO_MANIFEST_PATH],
  ["package.json", PACKAGE_PATH],
  ["pnpm-lock.yaml", PNPM_LOCK_PATH],
  ["supply-chain-policy.json", POLICY_PATH],
];

function fail(message) {
  throw new Error(message);
}

function read_json(file_path) {
  return JSON.parse(readFileSync(file_path, "utf8"));
}

function read_yaml(file_path) {
  try {
    return parse_yaml(readFileSync(file_path, "utf8"), {
      maxAliasCount: 0,
      uniqueKeys: true,
    });
  } catch (error) {
    fail(`Invalid YAML in ${path.basename(file_path)}: ${command_error_detail(error)}`);
  }
}

function command_error_detail(error) {
  if (error && typeof error === "object") {
    const stderr = "stderr" in error ? String(error.stderr ?? "").trim() : "";
    if (stderr) {
      return stderr;
    }
    if ("message" in error) {
      return String(error.message);
    }
  }
  return String(error);
}

function run_text_command(command, args, label) {
  try {
    return execFileSync(command, args, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail(`${label} failed: ${command_error_detail(error)}`);
  }
}

function run_json_command(command, args, label) {
  const output = run_text_command(command, args, label);
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`${label} returned invalid JSON: ${command_error_detail(error)}`);
  }
}

function normalize_path(file_path) {
  const normalized = path.normalize(path.resolve(file_path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function path_is_within(parent_path, candidate_path) {
  const relative_path = path.relative(parent_path, candidate_path);
  return relative_path.length > 0
    && !path.isAbsolute(relative_path)
    && relative_path !== ".."
    && !relative_path.startsWith(`..${path.sep}`);
}

function sha256_buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function compare_stable(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encode_purl_segment(value) {
  return encodeURIComponent(value).replace(/%2F/gi, "/");
}

function npm_purl(name, version) {
  if (name.startsWith("@")) {
    const separator_index = name.indexOf("/");
    if (separator_index <= 1 || separator_index === name.length - 1) {
      fail(`Invalid scoped npm package name: ${name}`);
    }
    const scope = encodeURIComponent(name.slice(0, separator_index));
    const package_name = encodeURIComponent(name.slice(separator_index + 1));
    return `pkg:npm/${scope}/${package_name}@${encode_purl_segment(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encode_purl_segment(version)}`;
}

function cargo_purl(name, version) {
  return `pkg:cargo/${encodeURIComponent(name)}@${encode_purl_segment(version)}`;
}

function generic_purl(name, version) {
  return `pkg:generic/${encodeURIComponent(name)}@${encode_purl_segment(version)}`;
}

function validate_policy(policy) {
  if (policy?.schemaVersion !== 3) {
    fail("supply-chain-policy.json schemaVersion must be 3");
  }
  if (!Array.isArray(policy.allowedLicenses) || policy.allowedLicenses.length === 0) {
    fail("supply-chain-policy.json allowedLicenses must be a non-empty array");
  }
  if (!Array.isArray(policy.allowedExceptions)) {
    fail("supply-chain-policy.json allowedExceptions must be an array");
  }
  if (!policy.licenseAliases || typeof policy.licenseAliases !== "object") {
    fail("supply-chain-policy.json licenseAliases must be an object");
  }
  if (!policy.licenseEvidence || typeof policy.licenseEvidence !== "object") {
    fail("supply-chain-policy.json licenseEvidence must be an object");
  }
  if (!Array.isArray(policy.reviewRequiredLicenses)) {
    fail("supply-chain-policy.json reviewRequiredLicenses must be an array");
  }
  if (!policy.reviewedComponents || typeof policy.reviewedComponents !== "object") {
    fail("supply-chain-policy.json reviewedComponents must be an object");
  }
  if (!policy.noticeFileSets || typeof policy.noticeFileSets !== "object") {
    fail("supply-chain-policy.json noticeFileSets must be an object");
  }
  if (!policy.noticeOverrides || typeof policy.noticeOverrides !== "object") {
    fail("supply-chain-policy.json noticeOverrides must be an object");
  }
  const license_set = new Set(policy.allowedLicenses);
  if (license_set.size !== policy.allowedLicenses.length) {
    fail("supply-chain-policy.json allowedLicenses contains duplicates");
  }
  const exception_set = new Set(policy.allowedExceptions);
  if (exception_set.size !== policy.allowedExceptions.length) {
    fail("supply-chain-policy.json allowedExceptions contains duplicates");
  }
  const review_license_set = new Set(policy.reviewRequiredLicenses);
  if (review_license_set.size !== policy.reviewRequiredLicenses.length) {
    fail("supply-chain-policy.json reviewRequiredLicenses contains duplicates");
  }
  for (const license of review_license_set) {
    if (!license_set.has(license)) {
      fail(`Review-required license is not allowed: ${license}`);
    }
  }

  const evidence_identifier_set = new Set([...license_set, ...exception_set]);
  for (const [identifier, evidence] of Object.entries(policy.licenseEvidence)) {
    if (!evidence_identifier_set.has(identifier)
      || typeof evidence?.start !== "string"
      || typeof evidence?.end !== "string"
      || evidence.start.length === 0
      || evidence.end.length === 0
      || evidence.start === evidence.end
      || normalized_evidence_text(evidence.start) !== evidence.start
      || normalized_evidence_text(evidence.end) !== evidence.end
      || !Array.isArray(evidence.hashes)
      || evidence.hashes.length === 0) {
      fail(`Invalid license evidence entry: ${identifier}`);
    }
    const evidence_hashes = new Set(evidence.hashes);
    if (evidence_hashes.size !== evidence.hashes.length
      || evidence.hashes.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))) {
      fail(`Invalid or duplicate license evidence hash: ${identifier}`);
    }
  }

  for (const [component_ref, review] of Object.entries(policy.reviewedComponents)) {
    if (!component_ref.startsWith("pkg:")
      || typeof review?.selectedLicense !== "string"
      || typeof review?.reason !== "string"
      || review.reason.trim().length === 0) {
      fail(`Invalid reviewed component entry: ${component_ref}`);
    }
    if (!review_license_set.has(review.selectedLicense)) {
      fail(`Reviewed component ${component_ref} does not select a review-required license`);
    }
  }

  const notice_set_evidence = new Map();
  for (const [set_name, files] of Object.entries(policy.noticeFileSets)) {
    if (!/^[a-z0-9-]+$/.test(set_name) || !Array.isArray(files) || files.length === 0) {
      fail(`Invalid notice file set: ${set_name}`);
    }
    let has_license_terms = false;
    const override_paths = new Set();
    const evidence_notices = [];
    for (const file of files) {
      if (!file || !["license", "notice"].includes(file.kind)
        || typeof file.path !== "string"
        || typeof file.source !== "string"
        || !file.source.startsWith("https://")
        || typeof file.sha256 !== "string"
        || !/^[0-9a-f]{64}$/.test(file.sha256)) {
        fail(`Invalid notice override file in set ${set_name}`);
      }
      const resolved_path = path.resolve(PROJECT_ROOT, file.path);
      if (!path_is_within(LEGAL_NOTICE_ROOT, resolved_path) || override_paths.has(resolved_path)) {
        fail(`Notice override path is invalid or duplicated in set ${set_name}: ${file.path}`);
      }
      if (!existsSync(resolved_path)) {
        fail(`Notice override file is missing in set ${set_name}: ${file.path}`);
      }
      const file_buffer = readFileSync(resolved_path);
      if (file_buffer.length === 0 || sha256_buffer(file_buffer) !== file.sha256) {
        fail(`Notice override hash does not match in set ${set_name}: ${file.path}`);
      }
      const evidence_text = normalize_notice_text(file_buffer, resolved_path);
      if (evidence_text.length === 0) {
        fail(`Notice override file is empty after normalization in set ${set_name}: ${file.path}`);
      }
      evidence_notices.push({ kind: file.kind, text: evidence_text });
      override_paths.add(resolved_path);
      has_license_terms ||= file.kind === "license";
    }
    if (!has_license_terms) {
      fail(`Notice file set must include license terms: ${set_name}`);
    }
    notice_set_evidence.set(set_name, detected_license_evidence(evidence_notices, policy));
  }

  for (const [component_ref, override] of Object.entries(policy.noticeOverrides)) {
    if (!component_ref.startsWith("pkg:")
      || typeof override?.selectedLicense !== "string"
      || typeof override?.reason !== "string"
      || override.reason.trim().length === 0
      || typeof override.fileSet !== "string"
      || !Object.hasOwn(policy.noticeFileSets, override.fileSet)) {
      fail(`Invalid notice override entry: ${component_ref}`);
    }
    if (!license_set.has(override.selectedLicense)) {
      fail(`Notice override ${component_ref} selects a disallowed license`);
    }
    if (!notice_set_evidence.get(override.fileSet).has(override.selectedLicense)) {
      fail(`Notice override ${component_ref} has no verified ${override.selectedLicense} terms`);
    }
  }
  return policy;
}

export function normalize_license_expression(expression, policy) {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    fail("Dependency license expression must be a non-empty string");
  }
  const trimmed = expression.trim();
  return policy.licenseAliases[trimmed] ?? trimmed;
}

function combine_selections(left, right) {
  if (!left || !right) {
    return null;
  }
  return {
    licenses: new Set([...left.licenses, ...right.licenses]),
    exceptions: new Set([...left.exceptions, ...right.exceptions]),
  };
}

function selection_score(selection, license_order, exception_order) {
  if (!selection) {
    return Number.POSITIVE_INFINITY;
  }
  const license_score = [...selection.licenses].reduce(
    (total, license) => total + (license_order.get(license) ?? 10_000),
    0,
  );
  const exception_score = [...selection.exceptions].reduce(
    (total, exception) => total + (exception_order.get(exception) ?? 10_000),
    0,
  );
  return selection.licenses.size * 100_000 + selection.exceptions.size * 10_000
    + license_score * 10 + exception_score;
}

function enumerate_spdx_selections(node, policy) {
  const allowed_licenses = new Set(policy.allowedLicenses);
  const allowed_exceptions = new Set(policy.allowedExceptions);
  if (typeof node?.license === "string") {
    if (node.plus || !allowed_licenses.has(node.license)) {
      return [];
    }
    if (node.exception && !allowed_exceptions.has(node.exception)) {
      return [];
    }
    return [{
      licenses: new Set([node.license]),
      exceptions: new Set(node.exception ? [node.exception] : []),
    }];
  }
  if (!node?.left || !node?.right) {
    fail("SPDX parser returned an unsupported expression node");
  }
  const left = enumerate_spdx_selections(node.left, policy);
  const right = enumerate_spdx_selections(node.right, policy);
  if (node.conjunction === "and") {
    return left.flatMap((left_selection) => (
      right.map((right_selection) => combine_selections(left_selection, right_selection))
    ));
  }
  if (node.conjunction === "or") {
    return [...left, ...right];
  }
  fail(`SPDX parser returned an unsupported conjunction: ${node.conjunction}`);
}

function approved_license_choices(expression, policy) {
  const normalized_expression = normalize_license_expression(expression, policy);
  let parsed_expression;
  try {
    parsed_expression = parse_spdx_expression(normalized_expression);
  } catch (error) {
    fail(
      `Invalid SPDX license expression ${normalized_expression}: ${command_error_detail(error)}`,
    );
  }
  const license_order = new Map(policy.allowedLicenses.map((license, index) => [license, index]));
  const exception_order = new Map(
    policy.allowedExceptions.map((exception, index) => [exception, index]),
  );
  const selections = enumerate_spdx_selections(parsed_expression, policy);
  if (selections.length === 0) {
    fail(`No approved license choice for expression: ${normalized_expression}`);
  }
  const unique_choices = new Map();
  for (const selection of selections.sort((left, right) => (
    selection_score(left, license_order, exception_order)
      - selection_score(right, license_order, exception_order)
  ))) {
    const licenses = [...selection.licenses].sort(
      (left, right) => license_order.get(left) - license_order.get(right),
    );
    const exceptions = [...selection.exceptions].sort(
      (left, right) => exception_order.get(left) - exception_order.get(right),
    );
    const choice_key = JSON.stringify([licenses, exceptions]);
    if (!unique_choices.has(choice_key)) {
      unique_choices.set(choice_key, {
        expression: normalized_expression,
        licenses,
        exceptions,
      });
    }
  }
  return [...unique_choices.values()];
}

export function select_approved_license(expression, policy) {
  return approved_license_choices(expression, policy)[0];
}

function selected_license_text(component) {
  return [...component.license.licenses, ...component.license.exceptions].join(" AND ");
}

function enforce_component_reviews(components, policy) {
  const review_required = new Set(policy.reviewRequiredLicenses);
  for (const component of components.values()) {
    const selected_licenses = component.license.licenses.filter(
      (license) => review_required.has(license),
    );
    if (selected_licenses.length === 0) {
      continue;
    }
    const review = policy.reviewedComponents[component.purl];
    const selected = selected_license_text(component);
    if (!review || review.selectedLicense !== selected) {
      fail(`Component requires an exact license review entry: ${component.purl} (${selected})`);
    }
  }
}

function split_npm_name(name) {
  if (!name.startsWith("@")) {
    return { group: null, name };
  }
  const separator_index = name.indexOf("/");
  return {
    group: name.slice(0, separator_index),
    name: name.slice(separator_index + 1),
  };
}

function npm_package_name_parts(package_name) {
  const parts = package_name.startsWith("@") ? package_name.split("/") : [package_name];
  if ((parts.length !== 1 && parts.length !== 2)
    || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    fail(`Invalid npm package name in lockfile: ${package_name}`);
  }
  return parts;
}

function validate_peer_suffix(snapshot_key, suffix) {
  let depth = 0;
  for (const character of suffix) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) {
        fail(`Unbalanced pnpm peer suffix: ${snapshot_key}`);
      }
    }
  }
  if (!suffix.startsWith("(") || depth !== 0) {
    fail(`Unbalanced pnpm peer suffix: ${snapshot_key}`);
  }
}

function base_key_for_snapshot(snapshot_key, package_records) {
  if (Object.hasOwn(package_records, snapshot_key)) {
    return snapshot_key;
  }
  const suffix_index = snapshot_key.indexOf("(");
  if (suffix_index <= 0) {
    fail(`pnpm snapshot has no package record: ${snapshot_key}`);
  }
  validate_peer_suffix(snapshot_key, snapshot_key.slice(suffix_index));
  const base_key = snapshot_key.slice(0, suffix_index);
  if (!Object.hasOwn(package_records, base_key)) {
    fail(`pnpm snapshot base package is missing: ${snapshot_key}`);
  }
  return base_key;
}

function parse_base_npm_key(base_key) {
  const separator_index = base_key.lastIndexOf("@");
  const minimum_index = base_key.startsWith("@") ? base_key.indexOf("/") + 1 : 1;
  if (separator_index < minimum_index || separator_index === base_key.length - 1) {
    fail(`Invalid pnpm package key: ${base_key}`);
  }
  const package_name = base_key.slice(0, separator_index);
  npm_package_name_parts(package_name);
  return {
    package_name,
    version: base_key.slice(separator_index + 1),
  };
}

function resolve_npm_snapshot(lockfile, dependency_name, reference) {
  if (typeof reference !== "string" || reference.length === 0) {
    fail(`Invalid pnpm dependency reference for ${dependency_name}`);
  }
  let snapshot_key;
  if (reference.startsWith("npm:")) {
    snapshot_key = reference.slice("npm:".length);
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) {
      fail(`Unsupported pnpm dependency locator for ${dependency_name}: ${reference}`);
    }
    snapshot_key = `${dependency_name}@${reference}`;
  }
  const snapshot = lockfile.snapshots?.[snapshot_key];
  if (!snapshot || typeof snapshot !== "object") {
    fail(`pnpm snapshot is missing for ${dependency_name}: ${snapshot_key}`);
  }
  const base_key = base_key_for_snapshot(snapshot_key, lockfile.packages);
  const locator = parse_base_npm_key(base_key);
  return {
    ...locator,
    snapshot_key,
    snapshot,
    package_record: lockfile.packages[base_key],
  };
}

function nearest_node_modules_container(package_directory) {
  let current_path = path.resolve(package_directory);
  while (true) {
    if (path.basename(current_path) === "node_modules") {
      return current_path;
    }
    const parent_path = path.dirname(current_path);
    if (parent_path === current_path) {
      fail(`Installed npm package is not inside node_modules: ${package_directory}`);
    }
    current_path = parent_path;
  }
}

function resolve_installed_npm_directory({
  dependency_name,
  parent_package_directory,
  required,
}) {
  const container_path = parent_package_directory
    ? nearest_node_modules_container(parent_package_directory)
    : path.join(PROJECT_ROOT, "node_modules");
  const candidate_path = path.join(container_path, ...npm_package_name_parts(dependency_name));
  if (!existsSync(candidate_path)) {
    if (required) {
      fail(`Installed npm dependency is missing: ${dependency_name} from ${container_path}`);
    }
    return null;
  }
  return realpathSync(candidate_path);
}

function npm_repository_url(repository) {
  const repository_url = typeof repository === "string" ? repository : repository?.url;
  if (typeof repository_url !== "string" || repository_url.length === 0) {
    return null;
  }
  return repository_url.replace(/^git\+/, "").replace(/^git:\/\//, "https://");
}

function dependency_version(record, dependency_name, dependency_kind) {
  if (!record || typeof record !== "object" || typeof record.version !== "string") {
    fail(`Invalid ${dependency_kind} lockfile entry for ${dependency_name}`);
  }
  return record.version;
}

function assert_root_dependency_set(manifest_dependencies, importer_dependencies, label) {
  const normalized_manifest = manifest_dependencies ?? {};
  const normalized_importer = importer_dependencies ?? {};
  const manifest_names = Object.keys(normalized_manifest).sort();
  const importer_names = Object.keys(normalized_importer).sort();
  if (JSON.stringify(manifest_names) !== JSON.stringify(importer_names)) {
    fail(`package.json and pnpm-lock.yaml ${label} do not match`);
  }
  for (const dependency_name of manifest_names) {
    if (typeof normalized_manifest[dependency_name] !== "string"
      || normalized_importer[dependency_name]?.specifier !== normalized_manifest[dependency_name]) {
      fail(
        `package.json and pnpm-lock.yaml ${label} specifier differs for ${dependency_name}`,
      );
    }
  }
}

export function collect_npm_runtime_graph(lockfile, package_manifest, policy, options = {}) {
  if (String(lockfile?.lockfileVersion) !== "9.0"
    || !lockfile.packages
    || typeof lockfile.packages !== "object"
    || !lockfile.snapshots
    || typeof lockfile.snapshots !== "object") {
    fail("pnpm-lock.yaml must use lockfileVersion 9.0 with packages and snapshots");
  }
  const importer = lockfile.importers?.["."];
  if (!importer || typeof importer !== "object") {
    fail("pnpm-lock.yaml root importer is missing");
  }
  assert_root_dependency_set(package_manifest.dependencies, importer.dependencies, "dependencies");
  assert_root_dependency_set(
    package_manifest.optionalDependencies,
    importer.optionalDependencies,
    "optionalDependencies",
  );

  const resolve_package_directory = options.resolve_package_directory
    ?? resolve_installed_npm_directory;
  const read_package_manifest = options.read_package_manifest
    ?? ((package_directory) => read_json(path.join(package_directory, "package.json")));
  const components = new Map();
  const dependencies = new Map();
  const root_dependencies = new Set();
  const snapshot_refs = new Map();
  const active_snapshots = new Set();
  const visited_snapshots = new Set();

  function visit_dependency(dependency_name, reference, parent_package_directory, required) {
    const resolved = resolve_npm_snapshot(lockfile, dependency_name, reference);
    if (visited_snapshots.has(resolved.snapshot_key)
      || active_snapshots.has(resolved.snapshot_key)) {
      return snapshot_refs.get(resolved.snapshot_key);
    }
    const package_directory = resolve_package_directory({
      dependency_name,
      parent_package_directory,
      required,
      snapshot_key: resolved.snapshot_key,
    });
    if (!package_directory) {
      return null;
    }
    const installed_manifest = read_package_manifest(package_directory);
    if (installed_manifest?.name !== resolved.package_name
      || installed_manifest?.version !== resolved.version) {
      fail(`Installed npm manifest does not match lockfile: ${resolved.snapshot_key}`);
    }
    if (typeof resolved.package_record?.resolution?.integrity !== "string") {
      fail(`pnpm package has no locked integrity: ${resolved.snapshot_key}`);
    }

    const license = select_approved_license(installed_manifest.license, policy);
    const purl = npm_purl(resolved.package_name, resolved.version);
    const name_parts = split_npm_name(resolved.package_name);
    const existing = components.get(purl);
    if (existing && existing.license.expression !== license.expression) {
      fail(`Conflicting npm component metadata for ${purl}`);
    }
    if (!existing) {
      components.set(purl, {
        ecosystem: "npm",
        group: name_parts.group,
        name: name_parts.name,
        display_name: resolved.package_name,
        version: resolved.version,
        purl,
        license,
        homepage: typeof installed_manifest.homepage === "string"
          ? installed_manifest.homepage
          : null,
        repository: npm_repository_url(installed_manifest.repository),
        distribution: typeof resolved.package_record.resolution.tarball === "string"
          ? resolved.package_record.resolution.tarball
          : null,
        description: typeof installed_manifest.description === "string"
          ? installed_manifest.description
          : null,
        package_directory,
        license_file: null,
      });
    }
    if (!dependencies.has(purl)) {
      dependencies.set(purl, new Set());
    }
    snapshot_refs.set(resolved.snapshot_key, purl);
    active_snapshots.add(resolved.snapshot_key);

    const optional_peer_names = new Set(
      Object.keys(resolved.package_record.peerDependencies ?? {}).filter(
        (peer_name) => resolved.package_record.peerDependenciesMeta?.[peer_name]?.optional === true,
      ),
    );
    for (const child_name of Object.keys(resolved.snapshot.dependencies ?? {}).sort()) {
      if (optional_peer_names.has(child_name)) {
        continue;
      }
      const child_purl = visit_dependency(
        child_name,
        resolved.snapshot.dependencies[child_name],
        package_directory,
        true,
      );
      dependencies.get(purl).add(child_purl);
    }
    for (const child_name of Object.keys(resolved.snapshot.optionalDependencies ?? {}).sort()) {
      if (optional_peer_names.has(child_name)) {
        continue;
      }
      const child_purl = visit_dependency(
        child_name,
        resolved.snapshot.optionalDependencies[child_name],
        package_directory,
        false,
      );
      if (child_purl) {
        dependencies.get(purl).add(child_purl);
      }
    }
    active_snapshots.delete(resolved.snapshot_key);
    visited_snapshots.add(resolved.snapshot_key);
    return purl;
  }

  const direct_dependencies = importer.dependencies ?? {};
  for (const dependency_name of Object.keys(direct_dependencies).sort()) {
    root_dependencies.add(visit_dependency(
      dependency_name,
      dependency_version(direct_dependencies[dependency_name], dependency_name, "dependency"),
      null,
      true,
    ));
  }
  const optional_dependencies = importer.optionalDependencies ?? {};
  for (const dependency_name of Object.keys(optional_dependencies).sort()) {
    const component_ref = visit_dependency(
      dependency_name,
      dependency_version(
        optional_dependencies[dependency_name],
        dependency_name,
        "optional dependency",
      ),
      null,
      false,
    );
    if (component_ref) {
      root_dependencies.add(component_ref);
    }
  }

  return { components, dependencies, root_dependencies };
}

function has_normal_dependency(dep) {
  return Array.isArray(dep.dep_kinds)
    && dep.dep_kinds.some((dep_kind) => dep_kind.kind === null);
}

function cargo_distribution_url(package_metadata) {
  return package_metadata.source?.startsWith("registry+")
    ? `https://crates.io/api/v1/crates/${encodeURIComponent(package_metadata.name)}/`
      + `${encodeURIComponent(package_metadata.version)}/download`
    : null;
}

export function collect_cargo_runtime_graph(metadata, policy) {
  const root_id = metadata?.resolve?.root;
  if (typeof root_id !== "string") {
    fail("cargo metadata did not provide a resolve root");
  }
  const packages_by_id = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const nodes_by_id = new Map(metadata.resolve.nodes.map((entry) => [entry.id, entry]));
  const root_package = packages_by_id.get(root_id);
  if (!root_package) {
    fail("cargo metadata resolve root is missing from packages");
  }

  const included_ids = new Set([root_id]);
  const queue = [root_id];
  while (queue.length > 0) {
    const package_id = queue.shift();
    const node = nodes_by_id.get(package_id);
    if (!node) {
      fail(`cargo metadata is missing resolve node ${package_id}`);
    }
    for (const dep of node.deps) {
      if (!has_normal_dependency(dep) || included_ids.has(dep.pkg)) {
        continue;
      }
      included_ids.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }

  const components = new Map();
  const package_refs = new Map();
  for (const package_id of [...included_ids].sort()) {
    if (package_id === root_id) {
      continue;
    }
    const package_metadata = packages_by_id.get(package_id);
    if (!package_metadata) {
      fail(`cargo metadata is missing package ${package_id}`);
    }
    const purl = cargo_purl(package_metadata.name, package_metadata.version);
    if (components.has(purl)) {
      fail(`Cargo package URL collision: ${purl}`);
    }
    const package_directory = path.dirname(package_metadata.manifest_path);
    const license_file = package_metadata.license_file
      ? path.resolve(package_directory, package_metadata.license_file)
      : null;
    components.set(purl, {
      ecosystem: "cargo",
      group: null,
      name: package_metadata.name,
      display_name: package_metadata.name,
      version: package_metadata.version,
      purl,
      license: select_approved_license(package_metadata.license, policy),
      homepage: package_metadata.homepage ?? null,
      repository: package_metadata.repository ?? null,
      distribution: cargo_distribution_url(package_metadata),
      description: package_metadata.description ?? null,
      package_directory,
      license_file,
    });
    package_refs.set(package_id, purl);
  }

  const dependencies = new Map();
  const root_dependencies = new Set();
  for (const package_id of included_ids) {
    const source_ref = package_id === root_id ? null : package_refs.get(package_id);
    if (source_ref && !dependencies.has(source_ref)) {
      dependencies.set(source_ref, new Set());
    }
    const node = nodes_by_id.get(package_id);
    for (const dep of node.deps) {
      if (!has_normal_dependency(dep) || !included_ids.has(dep.pkg)) {
        continue;
      }
      const target_ref = package_refs.get(dep.pkg);
      if (!target_ref) {
        fail(`Cargo dependency ${dep.pkg} has no component reference`);
      }
      if (package_id === root_id) {
        root_dependencies.add(target_ref);
      } else {
        dependencies.get(source_ref).add(target_ref);
      }
    }
  }

  return { root_package, components, dependencies, root_dependencies };
}

function merge_graphs(...graphs) {
  const components = new Map();
  const dependencies = new Map();
  const root_dependencies = new Set();

  for (const graph of graphs) {
    for (const [purl, component] of graph.components) {
      if (components.has(purl)) {
        fail(`Duplicate supply-chain component: ${purl}`);
      }
      components.set(purl, component);
    }
    for (const [source_ref, target_refs] of graph.dependencies) {
      dependencies.set(source_ref, new Set(target_refs));
    }
    for (const target_ref of graph.root_dependencies) {
      root_dependencies.add(target_ref);
    }
  }
  return { components, dependencies, root_dependencies };
}

function external_references(component) {
  const references = [];
  const seen_urls = new Set();
  for (const [type, url] of [
    ["vcs", component.repository],
    ["website", component.homepage],
    ["distribution", component.distribution],
  ]) {
    if (typeof url === "string" && url.length > 0 && !seen_urls.has(url)) {
      references.push({ type, url });
      seen_urls.add(url);
    }
  }
  return references;
}

function cyclonedx_component(component) {
  const output = {
    type: "library",
    "bom-ref": component.purl,
    name: component.name,
    version: component.version,
    scope: "required",
    licenses: [{ expression: component.license.expression }],
    purl: component.purl,
    properties: [
      { name: "vofa-ultra:ecosystem", value: component.ecosystem },
      {
        name: "vofa-ultra:selected-license",
        value: [...component.license.licenses, ...component.license.exceptions].join(" AND "),
      },
    ],
  };
  if (component.group) {
    output.group = component.group;
  }
  if (component.description) {
    output.description = component.description;
  }
  const references = external_references(component);
  if (references.length > 0) {
    output.externalReferences = references;
  }
  return output;
}

function supply_chain_input_hashes() {
  return Object.fromEntries(INPUT_FILES.map(([file_name, file_path]) => [
    file_name,
    sha256_buffer(readFileSync(file_path)),
  ]));
}

export function build_cyclonedx_bom({
  project_name,
  project_version,
  project_license,
  target_triple,
  graph,
  input_hashes = {},
}) {
  const root_purl = generic_purl(project_name, project_version);
  const components = [...graph.components.values()]
    .sort((left, right) => compare_stable(left.purl, right.purl))
    .map(cyclonedx_component);
  const dependency_entries = [
    {
      ref: root_purl,
      dependsOn: [...graph.root_dependencies].sort(),
    },
  ];
  for (const component of components) {
    dependency_entries.push({
      ref: component["bom-ref"],
      dependsOn: [...(graph.dependencies.get(component["bom-ref"]) ?? [])].sort(),
    });
  }

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": root_purl,
        name: project_name,
        version: project_version,
        licenses: [{ expression: project_license.expression }],
        purl: root_purl,
      },
      properties: [
        { name: "vofa-ultra:dependency-scope", value: "runtime" },
        { name: "vofa-ultra:rust-target", value: target_triple },
        ...Object.entries(input_hashes)
          .sort(([left], [right]) => compare_stable(left, right))
          .map(([file_name, hash]) => ({
            name: `vofa-ultra:input-sha256:${file_name}`,
            value: hash,
          })),
      ],
      tools: {
        components: [
          {
            type: "application",
            name: "Vofa-Ultra supply-chain generator",
            version: "4",
          },
        ],
      },
    },
    components,
    dependencies: dependency_entries,
  };
}

export function validate_cyclonedx_bom(bom) {
  if (bom?.bomFormat !== "CycloneDX" || bom.specVersion !== "1.6" || bom.version !== 1) {
    fail("Generated SBOM does not declare CycloneDX 1.6");
  }
  const root_component = bom.metadata?.component;
  const root_ref = root_component?.["bom-ref"];
  if (typeof root_component?.name !== "string"
    || typeof root_component?.version !== "string"
    || root_ref !== generic_purl(root_component.name, root_component.version)
    || root_component.purl !== root_ref) {
    fail("Generated SBOM root component is invalid");
  }
  const component_refs = new Set();
  for (const component of bom.components ?? []) {
    const component_ref = component["bom-ref"];
    if (typeof component_ref !== "string" || component_refs.has(component_ref)) {
      fail(`Generated SBOM has an invalid or duplicate component ref: ${component_ref}`);
    }
    if (component.purl !== component_ref || !Array.isArray(component.licenses)) {
      fail(`Generated SBOM component is incomplete: ${component_ref}`);
    }
    component_refs.add(component_ref);
  }
  const valid_refs = new Set([root_ref, ...component_refs]);
  const dependency_refs = new Set();
  for (const dependency of bom.dependencies ?? []) {
    if (!valid_refs.has(dependency.ref) || dependency_refs.has(dependency.ref)) {
      fail(`Generated SBOM dependency ref is invalid or duplicated: ${dependency.ref}`);
    }
    dependency_refs.add(dependency.ref);
    for (const target_ref of dependency.dependsOn ?? []) {
      if (!component_refs.has(target_ref)) {
        fail(`Generated SBOM dependency target is unknown: ${target_ref}`);
      }
    }
  }
  if (dependency_refs.size !== valid_refs.size) {
    fail("Generated SBOM must include a dependency entry for every component");
  }
}

export async function validate_cyclonedx_schema(bom) {
  const validator = new JsonStrictValidator(CycloneDxVersion.v1dot6);
  const validation_error = await validator.validate(JSON.stringify(bom));
  if (validation_error !== null) {
    fail(`Generated SBOM failed CycloneDX 1.6 schema validation: ${validation_error}`);
  }
}

function normalize_notice_text(buffer, file_path) {
  if (buffer.length > MAX_NOTICE_FILE_BYTES) {
    fail(`Dependency notice file exceeds ${MAX_NOTICE_FILE_BYTES} bytes: ${file_path}`);
  }
  if (buffer.includes(0)) {
    fail(`Dependency notice file is binary: ${file_path}`);
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trimEnd();
}

function notice_file_record(file_path, file_name, kind, source) {
  if (!existsSync(file_path)) {
    fail(`Declared dependency notice file is missing: ${file_path}`);
  }
  const text = normalize_notice_text(readFileSync(file_path), file_path);
  if (text.length === 0) {
    return null;
  }
  return {
    file_name,
    kind,
    source,
    text,
    hash: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

function normalized_evidence_text(text) {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function evidence_hash_matches(text, evidence) {
  const approved_hashes = new Set(evidence.hashes);
  let search_index = 0;
  while (search_index < text.length) {
    const start_index = text.indexOf(evidence.start, search_index);
    if (start_index < 0) {
      return false;
    }
    const end_index = text.indexOf(
      evidence.end,
      start_index + evidence.start.length,
    );
    if (end_index >= 0) {
      const candidate = text.slice(start_index, end_index + evidence.end.length);
      if (approved_hashes.has(sha256_buffer(Buffer.from(candidate, "utf8")))) {
        return true;
      }
    }
    search_index = start_index + evidence.start.length;
  }
  return false;
}

function detected_license_evidence(notices, policy) {
  const detected = new Set();
  for (const notice of notices.filter((candidate) => candidate.kind === "license")) {
    const text = normalized_evidence_text(notice.text);
    for (const [identifier, evidence] of Object.entries(policy.licenseEvidence)) {
      if (evidence_hash_matches(text, evidence)) {
        detected.add(identifier);
      }
    }
  }
  return detected;
}

function choice_text(choice) {
  return [...choice.licenses, ...choice.exceptions].join(" AND ");
}

function choice_has_evidence(choice, notices, policy) {
  const detected = detected_license_evidence(notices, policy);
  return [...choice.licenses, ...choice.exceptions].every((identifier) => (
    detected.has(identifier)
  ));
}

function reviewed_override_notices(component, policy, selected) {
  const override = policy.noticeOverrides[component.purl];
  if (!override || override.selectedLicense !== selected) {
    return null;
  }
  const notices = [];
  for (const file of policy.noticeFileSets[override.fileSet]) {
    const file_path = path.resolve(PROJECT_ROOT, file.path);
    const record = notice_file_record(
      file_path,
      file.path.replaceAll("\\", "/"),
      file.kind,
      file.source,
    );
    if (record) {
      notices.push(record);
    }
  }
  return notices;
}

function component_notice_files(component, policy) {
  if (!component.package_directory || !existsSync(component.package_directory)) {
    fail(`Installed package directory is missing for ${component.purl}`);
  }
  const candidate_paths = new Map();
  for (const entry of readdirSync(component.package_directory, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const kind = LICENSE_TERMS_FILE_PATTERN.test(entry.name)
      ? "license"
      : NOTICE_FILE_PATTERN.test(entry.name) ? "notice" : null;
    if (kind) {
      const candidate_path = path.join(component.package_directory, entry.name);
      candidate_paths.set(normalize_path(candidate_path), { candidate_path, kind });
    }
  }
  if (component.license_file) {
    const resolved_license_file = path.resolve(component.license_file);
    if (!path_is_within(path.resolve(component.package_directory), resolved_license_file)) {
      fail(`Declared dependency license file escapes its package: ${component.purl}`);
    }
    candidate_paths.set(normalize_path(resolved_license_file), {
      candidate_path: resolved_license_file,
      kind: "license",
    });
  }

  const notices = [];
  for (const { candidate_path, kind } of [...candidate_paths.values()].sort(
    (left, right) => compare_stable(left.candidate_path, right.candidate_path),
  )) {
    const record = notice_file_record(
      candidate_path,
      path.basename(candidate_path),
      kind,
      `packaged:${path.basename(candidate_path)}`,
    );
    if (record) {
      notices.push(record);
    }
  }

  const choices = approved_license_choices(component.license.expression, policy);
  const configured_override = policy.noticeOverrides[component.purl];
  if (configured_override && !choices.some((choice) => (
    choice_text(choice) === configured_override.selectedLicense
  ))) {
    fail(`Notice override does not match a declared license choice: ${component.purl}`);
  }
  for (const choice of choices) {
    if (choice_has_evidence(choice, notices, policy)) {
      component.license = choice;
      return { notices, override_used: false };
    }
    const override_notices = reviewed_override_notices(
      component,
      policy,
      choice_text(choice),
    );
    if (override_notices
      && choice_has_evidence(choice, [...notices, ...override_notices], policy)) {
      component.license = choice;
      return {
        notices: [...notices, ...override_notices],
        override_used: true,
      };
    }
  }
  const detected = [...detected_license_evidence(notices, policy)].sort().join(", ") || "none";
  const expected = choices.map(choice_text).join(" OR ");
  fail(
    `Dependency has no verified terms for an approved license choice: ${component.purl} `
      + `(expected ${expected}; detected ${detected})`,
  );
}

function component_upstream(component) {
  return component.repository ?? component.homepage ?? component.distribution ?? "not declared";
}

export function render_third_party_notices(components, target_triple, policy) {
  const sorted_components = [...components.values()]
    .sort((left, right) => compare_stable(left.purl, right.purl));
  const notice_texts = new Map();
  const override_components = [];
  const component_results = new Map();
  const evidence_errors = [];

  for (const component of sorted_components) {
    try {
      component_results.set(component.purl, component_notice_files(component, policy));
    } catch (error) {
      evidence_errors.push(command_error_detail(error));
    }
  }
  if (evidence_errors.length > 0) {
    fail(`License evidence validation failed:\n- ${evidence_errors.join("\n- ")}`);
  }

  for (const component of sorted_components) {
    const result = component_results.get(component.purl);
    if (result.override_used) {
      override_components.push(component.purl);
    }
    for (const notice of result.notices) {
      if (!notice_texts.has(notice.hash)) {
        notice_texts.set(notice.hash, {
          text: notice.text,
          file_names: new Set(),
          sources: new Set(),
          component_refs: new Set(),
        });
      }
      const entry = notice_texts.get(notice.hash);
      entry.file_names.add(notice.file_name);
      entry.sources.add(notice.source);
      entry.component_refs.add(component.purl);
    }
  }

  const lines = [
    "Vofa-Ultra third-party dependency notices",
    "===========================================",
    "",
    `Rust target: ${target_triple}`,
    "Scope: installed npm production dependencies and Cargo normal dependencies.",
    "Build-only and development-only dependencies are excluded.",
    "License choices are enforced by supply-chain-policy.json.",
    "",
    "COMPONENT INVENTORY",
    "===================",
    "",
    "PURL\tEcosystem\tComponent\tVersion\tDeclared license\tSelected license\tUpstream",
  ];
  for (const component of sorted_components) {
    const selected = selected_license_text(component);
    lines.push(
      `${component.purl}\t${component.ecosystem}\t${component.display_name}\t${component.version}`
        + `\t${component.license.expression}\t${selected}\t${component_upstream(component)}`,
    );
  }

  lines.push(
    "",
    "COMPONENTS USING REVIEWED NOTICE OVERRIDES",
    "===========================================",
    "",
    "These exact component versions do not package verified terms for the selected license.",
    "Their checked-in replacement texts and hashes are pinned by supply-chain-policy.json.",
    "",
  );
  if (override_components.length === 0) {
    lines.push("None");
  } else {
    lines.push(...override_components.map((component_ref) => `- ${component_ref}`));
  }

  lines.push(
    "",
    "LICENSE AND NOTICE TEXTS",
    "========================",
    "",
  );
  for (const [hash, entry] of [...notice_texts.entries()].sort(([left], [right]) => (
    compare_stable(left, right)
  ))) {
    lines.push(
      "--------------------------------------------------------------------------------",
      `Notice SHA-256: ${hash}`,
      `Source filenames: ${[...entry.file_names].sort().join(", ")}`,
      `Source references: ${[...entry.sources].sort().join(", ")}`,
      "Applies to:",
      ...[...entry.component_refs].sort().map((component_ref) => `- ${component_ref}`),
      "--------------------------------------------------------------------------------",
      entry.text,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function sha256_file(file_path) {
  const buffer = readFileSync(file_path);
  return createHash("sha256").update(buffer).digest("hex");
}

async function write_supply_chain_checksums(output_directory, file_names) {
  const lines = [];
  for (const file_name of [...file_names].sort()) {
    lines.push(`${await sha256_file(path.join(output_directory, file_name))}  ${file_name}`);
  }
  const checksum_name = "SUPPLY_CHAIN_SHA256SUMS";
  await writeFile(path.join(output_directory, checksum_name), `${lines.join("\n")}\n`, "utf8");
  return checksum_name;
}

function supply_chain_file_names(target_triple) {
  if (!/^[a-z0-9_.-]+$/i.test(target_triple)) {
    fail(`Invalid Rust target for supply-chain filenames: ${target_triple}`);
  }
  return {
    sbom_name: `vofa-ultra-${target_triple}.cdx.json`,
    notices_name: `THIRD_PARTY_NOTICES-${target_triple}.txt`,
    checksum_name: "SUPPLY_CHAIN_SHA256SUMS",
  };
}

function rust_target_from_bom(bom) {
  return bom.metadata?.properties?.find(
    (property) => property.name === "vofa-ultra:rust-target",
  )?.value;
}

export async function verify_supply_chain_artifacts(options) {
  const output_directory = path.resolve(options.output_directory);
  const platform_name = options.platform_name;
  const expected_target_triple = options.target_triple;
  if (typeof expected_target_triple !== "string") {
    fail("Supply-chain verification requires an exact Rust target triple");
  }
  const file_names = supply_chain_file_names(expected_target_triple);
  const sbom_path = path.join(output_directory, file_names.sbom_name);
  const notices_path = path.join(output_directory, file_names.notices_name);
  const checksum_path = path.join(output_directory, file_names.checksum_name);
  for (const file_path of [sbom_path, notices_path, checksum_path]) {
    if (!existsSync(file_path) || readFileSync(file_path).length === 0) {
      fail(`Supply-chain artifact is missing or empty: ${file_path}`);
    }
  }

  const sbom_text = readFileSync(sbom_path, "utf8");
  const notices = readFileSync(notices_path, "utf8");
  let bom;
  try {
    bom = JSON.parse(sbom_text);
  } catch (error) {
    fail(`Supply-chain SBOM is invalid JSON: ${command_error_detail(error)}`);
  }
  validate_cyclonedx_bom(bom);
  await validate_cyclonedx_schema(bom);
  const target_triple = rust_target_from_bom(bom);
  if (typeof target_triple !== "string"
    || platform_for_target(target_triple) !== platform_name
    || target_triple !== expected_target_triple) {
    fail(`Supply-chain SBOM target does not match platform ${platform_name}`);
  }

  const package_manifest = read_json(PACKAGE_PATH);
  const tauri_config = read_json(TAURI_CONFIG_PATH);
  const policy = validate_policy(read_json(POLICY_PATH));
  const root_component = bom.metadata.component;
  const project_license = select_approved_license(package_manifest.license, policy);
  if (root_component.name !== package_manifest.name
    || root_component.version !== package_manifest.version
    || root_component.version !== tauri_config.version
    || root_component.licenses?.[0]?.expression !== project_license.expression) {
    fail("Supply-chain SBOM root metadata does not match the current project");
  }

  const property_map = new Map();
  for (const property of bom.metadata.properties ?? []) {
    if (typeof property?.name !== "string"
      || typeof property?.value !== "string"
      || property_map.has(property.name)) {
      fail(`Supply-chain SBOM has an invalid metadata property: ${property?.name}`);
    }
    property_map.set(property.name, property.value);
  }
  if (property_map.get("vofa-ultra:dependency-scope") !== "runtime") {
    fail("Supply-chain SBOM dependency scope is not runtime");
  }
  const expected_input_hashes = supply_chain_input_hashes();
  for (const [file_name, hash] of Object.entries(expected_input_hashes)) {
    if (property_map.get(`vofa-ultra:input-sha256:${file_name}`) !== hash) {
      fail(`Supply-chain SBOM input hash is stale: ${file_name}`);
    }
  }

  const inventory_header =
    "PURL\tEcosystem\tComponent\tVersion\tDeclared license\tSelected license\tUpstream";
  const inventory_lines = notices.split("\n");
  const header_index = inventory_lines.indexOf(inventory_header);
  if (header_index < 0) {
    fail("Third-party notice inventory header is missing");
  }
  const inventory_refs = new Set();
  for (let index = header_index + 1; index < inventory_lines.length; index += 1) {
    const line = inventory_lines[index];
    if (line.length === 0) {
      break;
    }
    const fields = line.split("\t");
    if (fields.length !== 7 || inventory_refs.has(fields[0])) {
      fail(`Third-party notice inventory row is invalid: ${line}`);
    }
    inventory_refs.add(fields[0]);
  }
  const component_refs = new Set(bom.components.map((component) => component["bom-ref"]));
  if (inventory_refs.size !== component_refs.size
    || [...component_refs].some((component_ref) => !inventory_refs.has(component_ref))) {
    fail("Third-party notice inventory does not exactly match the SBOM components");
  }
  const local_paths = [PROJECT_ROOT, PROJECT_ROOT.replaceAll("\\", "/")];
  for (const local_path of local_paths) {
    if (sbom_text.includes(local_path) || notices.includes(local_path)) {
      fail("Supply-chain artifacts must not contain the local project path");
    }
  }

  const expected_checksum_lines = [];
  for (const file_name of [file_names.sbom_name, file_names.notices_name].sort()) {
    expected_checksum_lines.push(
      `${await sha256_file(path.join(output_directory, file_name))}  ${file_name}`,
    );
  }
  const expected_checksums = `${expected_checksum_lines.join("\n")}\n`;
  if (readFileSync(checksum_path, "utf8") !== expected_checksums) {
    fail("Supply-chain checksum manifest does not match the generated artifacts");
  }

  return {
    output_directory,
    platform_name,
    target_triple,
    component_count: bom.components.length,
    file_names: Object.values(file_names),
  };
}

function detect_target_triple() {
  const rustc_command = process.env.RUSTC || "rustc";
  const verbose_version = run_text_command(rustc_command, ["-vV"], "rustc target detection");
  const host_line = verbose_version.split(/\r?\n/).find((line) => line.startsWith("host: "));
  if (!host_line) {
    fail("rustc -vV did not report a host target");
  }
  return host_line.slice("host: ".length).trim();
}

function platform_for_target(target_triple) {
  if (target_triple.includes("windows")) {
    return "windows";
  }
  if (target_triple.includes("apple-darwin")) {
    return "macos";
  }
  if (target_triple.includes("linux")) {
    return "linux";
  }
  fail(`Unsupported Rust target for packaging: ${target_triple}`);
}

function validate_project_metadata(package_manifest, tauri_config, cargo_package, policy) {
  const versions = new Set([
    package_manifest.version,
    tauri_config.version,
    cargo_package.version,
  ]);
  if (versions.size !== 1) {
    fail("Package, Tauri, and Cargo versions must match before generating supply-chain metadata");
  }
  if (package_manifest.name !== cargo_package.name) {
    fail("Package and Cargo names must match before generating supply-chain metadata");
  }
  const licenses = new Set([
    package_manifest.license,
    tauri_config.bundle?.license,
    cargo_package.license,
  ]);
  if (licenses.size !== 1) {
    fail("Package, Tauri, and Cargo licenses must match before generating supply-chain metadata");
  }
  return select_approved_license(package_manifest.license, policy);
}

function dependency_inputs(target_triple) {
  const cargo_command = process.env.CARGO || "cargo";
  return {
    cargo_metadata: run_json_command(
      cargo_command,
      [
        "metadata",
        "--frozen",
        "--locked",
        "--filter-platform",
        target_triple,
        "--format-version",
        "1",
        "--manifest-path",
        CARGO_MANIFEST_PATH,
      ],
      "Cargo dependency graph",
    ),
  };
}

export function resolve_target_triple(explicit_target) {
  return explicit_target
    ?? process.env.TAURI_ENV_TARGET_TRIPLE
    ?? process.env.CARGO_BUILD_TARGET
    ?? detect_target_triple();
}

export async function generate_supply_chain_artifacts(options = {}) {
  const target_triple = resolve_target_triple(options.target_triple);
  const detected_platform = platform_for_target(target_triple);
  const platform_name = options.platform_name ?? detected_platform;
  if (platform_name !== detected_platform) {
    fail(`Platform ${platform_name} does not match Rust target ${target_triple}`);
  }
  const output_directory = path.resolve(
    options.output_directory
      ?? path.join(PROJECT_ROOT, "artifacts", "supply-chain", platform_name),
  );
  const policy = validate_policy(read_json(POLICY_PATH));
  const package_manifest = read_json(PACKAGE_PATH);
  const pnpm_lock = read_yaml(PNPM_LOCK_PATH);
  const tauri_config = read_json(TAURI_CONFIG_PATH);
  const inputs = dependency_inputs(target_triple);
  const npm_graph = collect_npm_runtime_graph(pnpm_lock, package_manifest, policy);
  const cargo_graph = collect_cargo_runtime_graph(inputs.cargo_metadata, policy);
  const project_license = validate_project_metadata(
    package_manifest,
    tauri_config,
    cargo_graph.root_package,
    policy,
  );
  const graph = merge_graphs(npm_graph, cargo_graph);
  const notices = render_third_party_notices(graph.components, target_triple, policy);
  enforce_component_reviews(graph.components, policy);
  const bom = build_cyclonedx_bom({
    project_name: package_manifest.name,
    project_version: package_manifest.version,
    project_license,
    target_triple,
    graph,
    input_hashes: supply_chain_input_hashes(),
  });
  validate_cyclonedx_bom(bom);
  await validate_cyclonedx_schema(bom);

  const file_names = supply_chain_file_names(target_triple);
  await mkdir(output_directory, { recursive: true });
  await writeFile(
    path.join(output_directory, file_names.sbom_name),
    `${JSON.stringify(bom, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(output_directory, file_names.notices_name), notices, "utf8");
  await write_supply_chain_checksums(
    output_directory,
    [file_names.sbom_name, file_names.notices_name],
  );
  return verify_supply_chain_artifacts({
    output_directory,
    platform_name,
    target_triple,
  });
}

async function check_supply_chain(target_triple) {
  const temporary_directory = await mkdtemp(path.join(tmpdir(), "vofa-ultra-supply-chain-"));
  try {
    return await generate_supply_chain_artifacts({
      output_directory: temporary_directory,
      target_triple,
    });
  } finally {
    await rm(temporary_directory, { recursive: true, force: true });
  }
}

async function generate_bundle_supply_chain(target_triple) {
  const output_directory = path.join(PROJECT_ROOT, "src-tauri", "gen", "supply-chain");
  const expected_directory = normalize_path(
    path.join(PROJECT_ROOT, "src-tauri", "gen", "supply-chain"),
  );
  if (normalize_path(output_directory) !== expected_directory) {
    fail("Refusing to clean an unexpected bundle supply-chain directory");
  }
  await rm(output_directory, { recursive: true, force: true });
  return generate_supply_chain_artifacts({ output_directory, target_triple });
}

async function main() {
  const [command, first_argument, second_argument] = process.argv.slice(2);
  let result;
  if (command === "generate") {
    result = await generate_supply_chain_artifacts({
      output_directory: first_argument,
      target_triple: second_argument,
    });
  } else if (command === "bundle") {
    result = await generate_bundle_supply_chain(first_argument);
  } else if (command === "check") {
    result = await check_supply_chain(first_argument);
  } else {
    fail(
      "Usage: supply-chain.mjs generate [output-directory] [target-triple] "
        + "| bundle [target-triple] | check [target-triple]",
    );
  }
  console.log(
    `Verified ${result.component_count} runtime components for ${result.target_triple}`,
  );
  if (command !== "check") {
    console.log(`Wrote supply-chain artifacts to ${result.output_directory}`);
  }
}

const is_main = process.argv[1]
  && normalize_path(process.argv[1]) === normalize_path(fileURLToPath(import.meta.url));
if (is_main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
