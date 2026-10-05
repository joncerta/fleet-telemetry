import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Convención de niveles: los *.int.test.ts son de integración y corren aparte.
    exclude: ["**/node_modules/**", "**/dist/**", "src/**/*.int.test.ts"],
  },
});
