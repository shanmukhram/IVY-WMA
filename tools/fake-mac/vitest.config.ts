import { defineConfig } from "vitest/config";

// Argon2id (64 MiB) runs once per identity unlock, so allow slow hooks.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
