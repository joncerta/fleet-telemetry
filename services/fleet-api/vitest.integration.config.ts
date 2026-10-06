import { loadRootEnv } from "@fleet/platform/testing";
import { defineConfig } from "vitest/config";

// Se carga antes de que vitest cree los workers, para que hereden las variables. No pisa las ya definidas.
loadRootEnv();

export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Falla con un mensaje claro si el stack local no responde; nunca salta los tests.
    globalSetup: ["./global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
