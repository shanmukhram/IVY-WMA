import { defineConfig } from "vitest/config";

// Argon2id (64 MiB, t=3) costs ~0.5 s per derivation; integration tests run several.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
