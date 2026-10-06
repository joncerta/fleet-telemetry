import { defineConfig } from "vitest/config";

// Unitarios: sin red ni DB. Los *.int.test.ts (integración) corren con vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "src/**/*.int.test.ts"],
  },
});
