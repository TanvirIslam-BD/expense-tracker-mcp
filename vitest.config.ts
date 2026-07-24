import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts is the process bootstrap (starts a listener / stdio loop) and
      // is covered by the HTTP smoke path rather than unit tests; types.ts is
      // interfaces only (no runtime code).
      exclude: ["src/index.ts", "src/store/types.ts"],
    },
  },
});
