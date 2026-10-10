import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 600_000,
    // One file at a time: the suite spawns real Vision helpers; parallel files skew latency numbers.
    fileParallelism: false,
  },
});
