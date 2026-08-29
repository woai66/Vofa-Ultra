import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { Plugin, Rollup } from "vite";

const INITIAL_JS_LIMIT_BYTES = 656 * 1024;
const INITIAL_JS_GZIP_LIMIT_BYTES = 202 * 1024;
const ATTITUDE_JS_LIMIT_BYTES = 650 * 1024;
const ATTITUDE_JS_GZIP_LIMIT_BYTES = 180 * 1024;
const ATTITUDE_PANEL_MODULE = "/src/components/AttitudePanel.tsx";
const THREE_MODULE_SEGMENT = "/node_modules/three/";
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const APP_VERSION = readAppVersion();
const APP_BUILD_ID = readAppBuildId();

export default defineConfig({
  plugins: [react(), frontendBundleBudget()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_BUILD_ID__: JSON.stringify(APP_BUILD_ID),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    chunkSizeWarningLimit: 650,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**", "**/test-results/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});

function frontendBundleBudget(): Plugin {
  return {
    name: "frontend-bundle-budget",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks = outputChunks(bundle);
      const entryChunks = chunks.filter((chunk) => chunk.isEntry);
      const initialFiles = collectStaticChunkFiles(entryChunks, bundle);
      const attitudeChunk = chunks.find((chunk) =>
        Object.keys(chunk.modules).some((moduleId) =>
          normalizeModuleId(moduleId).endsWith(ATTITUDE_PANEL_MODULE),
        ),
      );

      if (!attitudeChunk?.isDynamicEntry || initialFiles.has(attitudeChunk.fileName)) {
        throw new Error("姿态视图必须保持为入口之外的动态 chunk");
      }

      const initialChunks = chunks.filter((chunk) => initialFiles.has(chunk.fileName));
      const initialThreeModule = initialChunks
        .flatMap((chunk) => Object.keys(chunk.modules))
        .find((moduleId) => normalizeModuleId(moduleId).includes(THREE_MODULE_SEGMENT));
      if (initialThreeModule) {
        throw new Error(`Three.js 不得进入首屏静态依赖图：${initialThreeModule}`);
      }

      if (process.env.TAURI_ENV_DEBUG) {
        console.log("[bundle-budget] 调试构建已验证动态边界，跳过生产体积预算");
        return;
      }

      const attitudeFiles = collectStaticChunkFiles([attitudeChunk], bundle);
      for (const fileName of initialFiles) {
        attitudeFiles.delete(fileName);
      }

      const initialSize = measureChunks(initialFiles, bundle);
      const attitudeSize = measureChunks(attitudeFiles, bundle);
      assertBudget(
        "首屏 JS",
        initialSize,
        INITIAL_JS_LIMIT_BYTES,
        INITIAL_JS_GZIP_LIMIT_BYTES,
      );
      assertBudget(
        "姿态视图 JS",
        attitudeSize,
        ATTITUDE_JS_LIMIT_BYTES,
        ATTITUDE_JS_GZIP_LIMIT_BYTES,
      );

      console.log(
        `[bundle-budget] 首屏 ${formatSize(initialSize.raw)} ` +
          `(gzip ${formatSize(initialSize.gzip)})；姿态视图 ${formatSize(attitudeSize.raw)} ` +
          `(gzip ${formatSize(attitudeSize.gzip)})`,
      );
    },
  };
}

function outputChunks(bundle: Rollup.OutputBundle): Rollup.OutputChunk[] {
  return Object.values(bundle).filter(
    (output): output is Rollup.OutputChunk => output.type === "chunk",
  );
}

function collectStaticChunkFiles(
  roots: readonly Rollup.OutputChunk[],
  bundle: Rollup.OutputBundle,
): Set<string> {
  const files = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const chunk = pending.pop();
    if (!chunk || files.has(chunk.fileName)) {
      continue;
    }
    files.add(chunk.fileName);
    for (const importedFile of chunk.imports) {
      const imported = bundle[importedFile];
      if (imported?.type === "chunk") {
        pending.push(imported);
      }
    }
  }
  return files;
}

function measureChunks(
  fileNames: ReadonlySet<string>,
  bundle: Rollup.OutputBundle,
): { raw: number; gzip: number } {
  let raw = 0;
  let gzip = 0;
  for (const fileName of fileNames) {
    const output = bundle[fileName];
    if (output?.type !== "chunk") {
      continue;
    }
    raw += Buffer.byteLength(output.code);
    gzip += gzipSync(output.code).byteLength;
  }
  return { raw, gzip };
}

function assertBudget(
  label: string,
  size: { raw: number; gzip: number },
  rawLimit: number,
  gzipLimit: number,
): void {
  if (size.raw > rawLimit || size.gzip > gzipLimit) {
    throw new Error(
      `${label} 超出预算：${formatSize(size.raw)} / gzip ${formatSize(size.gzip)}，` +
        `上限 ${formatSize(rawLimit)} / gzip ${formatSize(gzipLimit)}`,
    );
  }
}

function normalizeModuleId(moduleId: string): string {
  return moduleId.replaceAll("\\", "/");
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function readAppVersion(): string {
  const packageManifest = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof packageManifest.version !== "string" || packageManifest.version.length === 0) {
    throw new Error("package.json version 必须是非空字符串");
  }
  return packageManifest.version;
}

function readAppBuildId(): string {
  const configuredBuildId = process.env.VOFA_ULTRA_BUILD_ID;
  if (configuredBuildId) {
    return normalizeBuildId(configuredBuildId);
  }

  try {
    const safeDirectory = PROJECT_ROOT.replaceAll("\\", "/");
    const gitArguments = ["-c", `safe.directory=${safeDirectory}`];
    const commit = execFileSync(
      "git",
      [...gitArguments, "rev-parse", "--short=12", "HEAD^{commit}"],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const dirty = execFileSync(
      "git",
      [...gitArguments, "status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim().length > 0;
    return normalizeBuildId(`${commit}${dirty ? "-dirty" : ""}`);
  } catch {
    return "development";
  }
}

function normalizeBuildId(value: string): string {
  const normalized = value.trim().toLowerCase();
  const match = /^([0-9a-f]{7,40})(-dirty)?$/.exec(normalized);
  if (match) {
    return `${match[1]?.slice(0, 12)}${match[2] ?? ""}`;
  }
  if (normalized === "development") {
    return normalized;
  }
  throw new Error("VOFA_ULTRA_BUILD_ID 必须是 7 到 40 位 Git commit，或 development");
}
