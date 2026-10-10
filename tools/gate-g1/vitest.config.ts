import { defineConfig } from "vitest/config";

// The integration test runs the real Mac service (Argon2id unlocks) against the S3 mock.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 60_000, pool: "forks" } });
