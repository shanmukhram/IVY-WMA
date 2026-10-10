import { defineConfig } from "vitest/config";

// End-to-end smoke: the real service (child process) + S3 mock + Playwright chromium.
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    pool: "forks",
  },
});
