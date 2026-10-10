import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OcrError } from "./errors.js";

/** mac/ocr (works from both src/ and dist/). */
export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const swiftPackageDir = join(packageRoot, "swift");
export const releaseDir = join(swiftPackageDir, ".build", "release");
export const defaultBinaryPath = join(releaseDir, "ivy-ocr");
/** Test-only fixture generator built from the same Swift package. */
export const fixtureBinaryPath = join(releaseDir, "ivy-fixture");

function newestSourceMtime(): number {
  let newest = 0;
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".swift")) newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  newest = statSync(join(swiftPackageDir, "Package.swift")).mtimeMs;
  walk(join(swiftPackageDir, "Sources"));
  return newest;
}

function isStale(bin: string): boolean {
  if (!existsSync(bin)) return true;
  try {
    return newestSourceMtime() > statSync(bin).mtimeMs;
  } catch {
    return false; // sources not shipped: trust the binary
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

let building: Promise<void> | undefined;

/** Runs `swift build -c release` for the helper package. Single-flight per process. */
export function buildSwift(onLog?: (line: string) => void): Promise<void> {
  building ??= (async () => {
    if (process.platform !== "darwin") {
      throw new OcrError("unsupported_platform", "@ivy/mac-ocr requires macOS (Apple Vision).");
    }
    try {
      await run("swift", ["--version"], 30_000);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      throw new OcrError(
        "toolchain_missing",
        e.code === "ENOENT"
          ? "Swift toolchain not found on PATH, so the ivy-ocr helper cannot be built. Install the Xcode Command Line Tools (`xcode-select --install`) or set IVY_OCR_BIN to a prebuilt binary."
          : `Swift toolchain is not usable (\`swift --version\` failed: ${e.message}). Check \`xcode-select -p\`, or set IVY_OCR_BIN to a prebuilt binary.`,
      );
    }
    onLog?.(`[mac-ocr] building Swift helper in ${swiftPackageDir} (swift build -c release)`);
    try {
      await run("swift", ["build", "-c", "release", "--package-path", swiftPackageDir], 15 * 60_000);
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string };
      const tail = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim().split("\n").slice(-25).join("\n");
      throw new OcrError("build_failed", `swift build failed for ${swiftPackageDir}:\n${tail}`);
    }
    if (!existsSync(defaultBinaryPath)) {
      throw new OcrError("build_failed", `swift build succeeded but ${defaultBinaryPath} is missing`);
    }
  })().finally(() => {
    building = undefined;
  });
  return building;
}

/**
 * Resolves the helper binary: explicit path, then IVY_OCR_BIN, then the package's release build
 * (built on first use, and rebuilt when the Swift sources are newer than the binary).
 */
export async function ensureBinary(opts: { binaryPath?: string; autoBuild?: boolean; onLog?: (l: string) => void } = {}): Promise<string> {
  if (process.platform !== "darwin") {
    throw new OcrError("unsupported_platform", "@ivy/mac-ocr requires macOS (Apple Vision).");
  }
  const explicit = opts.binaryPath ?? process.env.IVY_OCR_BIN;
  if (explicit) {
    if (!existsSync(explicit)) throw new OcrError("binary_missing", `ivy-ocr binary not found at ${explicit}`);
    return explicit;
  }
  if (!isStale(defaultBinaryPath)) return defaultBinaryPath;
  if (opts.autoBuild === false) {
    if (existsSync(defaultBinaryPath)) return defaultBinaryPath; // stale but allowed
    throw new OcrError(
      "binary_missing",
      `ivy-ocr is not built. Run \`pnpm --filter @ivy/mac-ocr run build:swift\` (expects ${defaultBinaryPath}).`,
    );
  }
  try {
    await buildSwift(opts.onLog);
  } catch (err) {
    // A stale-but-present binary beats no OCR when the toolchain has gone away.
    if (err instanceof OcrError && err.code === "toolchain_missing" && existsSync(defaultBinaryPath)) {
      opts.onLog?.(`[mac-ocr] ${err.message} Using the existing (possibly stale) binary.`);
      return defaultBinaryPath;
    }
    throw err;
  }
  return defaultBinaryPath;
}
