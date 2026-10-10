import { existsSync } from "node:fs";
import { ensureBinary, fixtureBinaryPath } from "../src/binary.js";

// Builds the Swift package (helper + fixture generator) once before any test file runs.
export default async function setup(): Promise<void> {
  const t0 = Date.now();
  await ensureBinary({ onLog: (l) => console.log(l) });
  if (!existsSync(fixtureBinaryPath)) throw new Error(`fixture generator missing at ${fixtureBinaryPath}`);
  console.log(`[mac-ocr tests] Swift helper ready (${Date.now() - t0} ms)`);
}
