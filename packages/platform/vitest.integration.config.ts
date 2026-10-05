import { defineConfig } from "vitest/config";
import { loadRootEnv } from "./src/testing/env.js";

// Se carga antes de que vitest cree los workers, para que hereden las variables. No pisa las ya definidas.
loadRootEnv();

export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Falla con un mensaje claro si el stack local no responde; nunca salta los tests.
    globalSetup: ["./src/testing/global-setup.ts"],
    // Las bases temporales comparten los roles fleet_app y fleet_ro, que son del cluster: en serie.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
