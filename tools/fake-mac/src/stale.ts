/**
 * @ivy/protocol is consumed through its built dist/. If its src/ has changed
 * since the last build, warn: a stale build silently disagrees with the current
 * schemas (e.g. rejects a status the Windows app now sends).
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function staleProtocolBuild(): string | null {
  try {
    const dist = dirname(fileURLToPath(import.meta.resolve("@ivy/protocol")));
    const src = join(dist, "..", "src");
    const mtimes = (dir: string, ext: string) =>
      readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => statSync(join(dir, f)).mtimeMs);
    const newestSrc = Math.max(...mtimes(src, ".ts"));
    const oldestDist = Math.min(...mtimes(dist, ".js"));
    if (newestSrc > oldestDist) return "WARNING: @ivy/protocol src/ is newer than its dist/; run `pnpm --filter @ivy/protocol build` so fake-mac uses the current schemas.";
  } catch { /* not a workspace checkout, or no src: nothing to compare */ }
  return null;
}
