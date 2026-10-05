import { loadRootEnv } from "@fleet/platform/testing";
import { defineConfig } from "vitest/config";

// Se carga antes de que vitest cree los workers, para que hereden las variables. No pisa las ya definidas.
loadRootEnv();

export default defineConfig({
  test: {
    include: ["**/*.e2e.test.ts"],
    exclude: ["**/node_modules/**"],
    // Falla con un mensaje claro si el stack local no responde; nunca salta los tests.
    globalSetup: ["./global-setup.ts"],
    // Los flujos e2e comparten el stack real: en serie, con datos aislados por runId.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
