import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluate_performance_report,
  parse_performance_budget,
  render_performance_markdown,
} from "./performance-budget.mjs";

const BASE_BUDGET = {
  schemaVersion: 1,
  benchmarks: [
    {
      id: "协议 > FireWater",
      maxMedianMs: 10,
      minimumSamples: 12,
      workAmount: 1_048_576,
      workUnit: "bytes",
    },
  ],
};

test("accepts an exact benchmark set and renders normalized reports", () => {
  const summary = evaluate_performance_report(
    benchmark_report([{ group: "协议", name: "FireWater", median: 5, samples: 20 }]),
    BASE_BUDGET,
    {
      generatedAt: "2026-08-25T00:00:00.000Z",
      nodeVersion: "v22.23.2",
      platform: "linux",
      arch: "x64",
    },
  );

  assert.equal(summary.passed, true);
  assert.equal(summary.results[0].throughputPerSecond, 209_715_200);
  assert.equal(summary.results[0].budgetUsagePercent, 50);
  assert.match(render_performance_markdown(summary), /200\.0 MiB\/s/);
  assert.match(render_performance_markdown(summary), /\| PASS \|/);
});

test("reports median and sample failures without hiding diagnostics", () => {
  const summary = evaluate_performance_report(
    benchmark_report([{ group: "协议", name: "FireWater", median: 12, samples: 4 }]),
    BASE_BUDGET,
  );

  assert.equal(summary.passed, false);
  assert.deepEqual(summary.results[0].failures, ["median-budget", "sample-count"]);
  assert.match(render_performance_markdown(summary), /FAIL \(median-budget, sample-count\)/);
});

test("fails closed for missing, unexpected, duplicate, and malformed scenarios", () => {
  assert.throws(
    () => evaluate_performance_report(benchmark_report([]), BASE_BUDGET),
    /缺失：协议 > FireWater/,
  );
  assert.throws(
    () =>
      evaluate_performance_report(
        benchmark_report([
          { group: "协议", name: "FireWater", median: 5, samples: 20 },
          { group: "协议", name: "JustFloat", median: 5, samples: 20 },
        ]),
        BASE_BUDGET,
      ),
    /未预算：协议 > JustFloat/,
  );
  assert.throws(
    () =>
      evaluate_performance_report(
        benchmark_report([
          { group: "协议", name: "FireWater", median: 5, samples: 20 },
          { group: "协议", name: "FireWater", median: 5, samples: 20 },
        ]),
        BASE_BUDGET,
      ),
    /重复场景/,
  );
  assert.throws(
    () =>
      evaluate_performance_report(
        benchmark_report([{ group: "协议", name: "FireWater", median: 0, samples: 20 }]),
        BASE_BUDGET,
      ),
    /median.*有限正数/,
  );
});

test("strictly validates the tracked budget schema", () => {
  assert.throws(
    () => parse_performance_budget({ ...BASE_BUDGET, extra: true }),
    /字段不匹配/,
  );
  assert.throws(
    () =>
      parse_performance_budget({
        ...BASE_BUDGET,
        benchmarks: [...BASE_BUDGET.benchmarks, BASE_BUDGET.benchmarks[0]],
      }),
    /重复场景/,
  );
  assert.throws(
    () =>
      parse_performance_budget({
        ...BASE_BUDGET,
        benchmarks: [{ ...BASE_BUDGET.benchmarks[0], workUnit: "widgets" }],
      }),
    /workUnit 不受支持/,
  );
});

function benchmark_report(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const benchmarks = groups.get(entry.group) ?? [];
    benchmarks.push({
      name: entry.name,
      median: entry.median,
      sampleCount: entry.samples,
      rme: 1.25,
    });
    groups.set(entry.group, benchmarks);
  }
  return {
    files: [
      {
        filepath: "benchmark.bench.ts",
        groups: [...groups.entries()].map(([fullName, benchmarks]) => ({
          fullName: `benchmarks/benchmark.bench.ts > ${fullName}`,
          benchmarks,
        })),
      },
    ],
  };
}
