#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RAW_REPORT = path.join(PROJECT_ROOT, "artifacts", "performance", "vitest.json");
const DEFAULT_BUDGET = path.join(PROJECT_ROOT, "performance-budgets.json");
const DEFAULT_OUTPUT_DIRECTORY = path.join(PROJECT_ROOT, "artifacts", "performance");
const WORK_UNITS = new Set(["bytes", "evaluations", "frames"]);
const BUDGET_KEYS = [
  "id",
  "maxMedianMs",
  "minimumSamples",
  "workAmount",
  "workUnit",
];

export function parse_performance_budget(value) {
  const root = require_record(value, "性能预算");
  assert_exact_keys(root, ["benchmarks", "schemaVersion"], "性能预算");
  if (root.schemaVersion !== 1) {
    throw new Error(`不支持的性能预算版本：${String(root.schemaVersion)}`);
  }
  if (!Array.isArray(root.benchmarks) || root.benchmarks.length === 0) {
    throw new Error("性能预算必须包含至少一个场景");
  }

  const ids = new Set();
  const benchmarks = root.benchmarks.map((value, index) => {
    const label = `性能预算场景 ${index + 1}`;
    const entry = require_record(value, label);
    assert_exact_keys(entry, BUDGET_KEYS, label);
    const id = require_non_empty_string(entry.id, `${label}.id`);
    if (ids.has(id)) {
      throw new Error(`性能预算包含重复场景：${id}`);
    }
    ids.add(id);
    const max_median_ms = require_positive_number(
      entry.maxMedianMs,
      `${label}.maxMedianMs`,
    );
    const minimum_samples = require_positive_integer(
      entry.minimumSamples,
      `${label}.minimumSamples`,
    );
    const work_amount = require_positive_number(entry.workAmount, `${label}.workAmount`);
    const work_unit = require_non_empty_string(entry.workUnit, `${label}.workUnit`);
    if (!WORK_UNITS.has(work_unit)) {
      throw new Error(`${label}.workUnit 不受支持：${work_unit}`);
    }
    return {
      id,
      maxMedianMs: max_median_ms,
      minimumSamples: minimum_samples,
      workAmount: work_amount,
      workUnit: work_unit,
    };
  });
  return { schemaVersion: 1, benchmarks };
}

export function evaluate_performance_report(raw_report, raw_budget, environment = {}) {
  const budget = parse_performance_budget(raw_budget);
  const observed = flatten_benchmark_report(raw_report);
  const expected_ids = new Set(budget.benchmarks.map((entry) => entry.id));
  const missing = budget.benchmarks
    .map((entry) => entry.id)
    .filter((id) => !observed.has(id));
  const unexpected = [...observed.keys()].filter((id) => !expected_ids.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `性能场景集合不匹配；缺失：${format_list(missing)}；未预算：${format_list(unexpected)}`,
    );
  }

  const results = budget.benchmarks.map((entry) => {
    const measurement = observed.get(entry.id);
    if (!measurement) {
      throw new Error(`找不到性能场景：${entry.id}`);
    }
    const within_median = measurement.median <= entry.maxMedianMs;
    const enough_samples = measurement.sampleCount >= entry.minimumSamples;
    return {
      id: entry.id,
      medianMs: measurement.median,
      maxMedianMs: entry.maxMedianMs,
      sampleCount: measurement.sampleCount,
      minimumSamples: entry.minimumSamples,
      rmePercent: measurement.rme,
      workAmount: entry.workAmount,
      workUnit: entry.workUnit,
      throughputPerSecond: entry.workAmount * 1_000 / measurement.median,
      budgetUsagePercent: measurement.median / entry.maxMedianMs * 100,
      passed: within_median && enough_samples,
      failures: [
        ...(within_median ? [] : ["median-budget"]),
        ...(enough_samples ? [] : ["sample-count"]),
      ],
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: environment.generatedAt ?? new Date().toISOString(),
    environment: {
      nodeVersion: environment.nodeVersion ?? process.version,
      platform: environment.platform ?? process.platform,
      arch: environment.arch ?? process.arch,
    },
    passed: results.every((result) => result.passed),
    results,
  };
}

export function render_performance_markdown(summary) {
  const lines = [
    "# 性能基准报告",
    "",
    `- 结果：${summary.passed ? "PASS" : "FAIL"}`,
    `- 环境：Node ${summary.environment.nodeVersion} / ${summary.environment.platform} / ` +
      summary.environment.arch,
    `- 生成时间：${summary.generatedAt}`,
    "",
    "| 场景 | 中位数 | 上限 | 预算占用 | 吞吐 | 样本 | RME | 状态 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const result of summary.results) {
    lines.push(
      `| ${escape_markdown_cell(result.id)} | ${format_milliseconds(result.medianMs)} | ` +
        `${format_milliseconds(result.maxMedianMs)} | ` +
        `${result.budgetUsagePercent.toFixed(1)}% | ${format_throughput(result)} | ` +
        `${result.sampleCount} | ${result.rmePercent.toFixed(2)}% | ` +
        `${result.passed ? "PASS" : `FAIL (${result.failures.join(", ")})`} |`,
    );
  }
  lines.push(
    "",
    "门禁使用预热后的中位数和宽松上限识别数量级回退；原始 Vitest JSON 保留完整分位数供诊断。",
    "",
  );
  return lines.join("\n");
}

export async function verify_performance_budget({
  rawReportPath = DEFAULT_RAW_REPORT,
  budgetPath = DEFAULT_BUDGET,
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
} = {}) {
  const [raw_report, raw_budget] = await Promise.all([
    read_json(rawReportPath),
    read_json(budgetPath),
  ]);
  const summary = evaluate_performance_report(raw_report, raw_budget);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(outputDirectory, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(outputDirectory, "summary.md"),
      render_performance_markdown(summary),
      "utf8",
    ),
  ]);
  if (!summary.passed) {
    const failures = summary.results
      .filter((result) => !result.passed)
      .map((result) => result.id);
    throw new Error(`性能预算未通过：${failures.join("；")}`);
  }
  return summary;
}

function flatten_benchmark_report(value) {
  const root = require_record(value, "Vitest benchmark 报告");
  if (!Array.isArray(root.files) || root.files.length === 0) {
    throw new Error("Vitest benchmark 报告没有文件");
  }
  const observed = new Map();
  for (const [file_index, file_value] of root.files.entries()) {
    const file = require_record(file_value, `benchmark 文件 ${file_index + 1}`);
    const file_path = require_non_empty_string(
      file.filepath,
      `benchmark 文件 ${file_index + 1}.filepath`,
    );
    if (!Array.isArray(file.groups)) {
      throw new Error(`benchmark 文件 ${file_index + 1}.groups 必须是数组`);
    }
    for (const [group_index, group_value] of file.groups.entries()) {
      const group = require_record(group_value, `benchmark 分组 ${group_index + 1}`);
      const full_name = require_non_empty_string(group.fullName, "benchmark 分组名称");
      const group_name = normalize_group_name(full_name, file_path);
      if (!Array.isArray(group.benchmarks)) {
        throw new Error(`benchmark 分组 ${full_name} 没有 benchmarks 数组`);
      }
      for (const benchmark_value of group.benchmarks) {
        const benchmark = require_record(benchmark_value, `benchmark ${full_name}`);
        const name = require_non_empty_string(benchmark.name, `benchmark ${full_name}.name`);
        const id = `${group_name} > ${name}`;
        if (observed.has(id)) {
          throw new Error(`Vitest benchmark 报告包含重复场景：${id}`);
        }
        observed.set(id, {
          median: require_positive_number(benchmark.median, `${id}.median`),
          sampleCount: require_positive_integer(benchmark.sampleCount, `${id}.sampleCount`),
          rme: require_non_negative_number(benchmark.rme, `${id}.rme`),
        });
      }
    }
  }
  return observed;
}

function normalize_group_name(full_name, file_path) {
  const segments = full_name.split(" > ");
  const first_segment = segments[0]?.replaceAll("\\", "/") ?? "";
  const benchmark_file = path.posix.basename(file_path.replaceAll("\\", "/"));
  if (
    segments.length > 1 &&
    path.posix.basename(first_segment) === benchmark_file &&
    /\.bench\.[cm]?[jt]sx?$/.test(benchmark_file)
  ) {
    return segments.slice(1).join(" > ");
  }
  return full_name;
}

async function read_json(file_path) {
  return JSON.parse(await readFile(file_path, "utf8"));
}

function require_record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  return value;
}

function require_non_empty_string(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}必须是非空字符串`);
  }
  return value;
}

function require_positive_number(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}必须是有限正数`);
  }
  return value;
}

function require_non_negative_number(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label}必须是有限非负数`);
  }
  return value;
}

function require_positive_integer(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label}必须是正整数`);
  }
  return value;
}

function assert_exact_keys(record, expected_keys, label) {
  const expected = new Set(expected_keys);
  const actual = Object.keys(record);
  const unknown = actual.filter((key) => !expected.has(key));
  const missing = expected_keys.filter((key) => !(key in record));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label}字段不匹配；缺失：${format_list(missing)}；未知：${format_list(unknown)}`,
    );
  }
}

function format_list(values) {
  return values.length > 0 ? values.join("、") : "无";
}

function format_milliseconds(value) {
  return `${value.toFixed(3)} ms`;
}

function format_throughput(result) {
  if (result.workUnit === "bytes") {
    return `${(result.throughputPerSecond / MEBIBYTE).toFixed(1)} MiB/s`;
  }
  const labels = {
    evaluations: "求值/s",
    frames: "帧/s",
  };
  return `${Math.round(result.throughputPerSecond).toLocaleString("en-US")} ` +
    (labels[result.workUnit] ?? `${result.workUnit}/s`);
}

function escape_markdown_cell(value) {
  return value.replaceAll("|", "\\|");
}

const MEBIBYTE = 1024 * 1024;
const is_main = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (is_main) {
  const [rawReportPath, budgetPath, outputDirectory] = process.argv.slice(2);
  verify_performance_budget({ rawReportPath, budgetPath, outputDirectory })
    .then((summary) => {
      console.log(
        `性能预算通过：${summary.results.length} 个场景，报告位于 ${
          outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY
        }`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
