import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

const packageManifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: unknown };
if (typeof packageManifest.version !== "string" || packageManifest.version.length === 0) {
  throw new Error("package.json version 必须是非空字符串");
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageManifest.version),
  },
  test: {
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    setupFiles: [],
    benchmark: {
      include: ["benchmarks/**/*.bench.ts"],
    },
  },
});
