import { loadRootEnv } from "@fleet/platform/testing";
import { defineConfig, devices } from "@playwright/test";
import { AGENT_URL, E2E_HOST, E2E_WEB_PORT, FLEET_API_URL, WEB_URL } from "./e2e/support/env";

// El `.env` de la raíz (si existe) antes de que Playwright cree los workers: lo heredan. No pisa variables ya definidas.
loadRootEnv();

/**
 * E2E de la web contra el stack real: infraestructura del `docker compose` local y los servicios desde `dist/`, que levanta el fixture
 * `stack` (e2e/support/stack.ts) en puertos propios. La web se compila con la URL de ESE fleet-api (las `NEXT_PUBLIC_*` se fijan al
 * compilar) en `.next-e2e`, para no pisar el build normal.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  // Un solo worker: los flujos comparten los servicios del e2e y uno de ellos reinicia fleet-api.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: WEB_URL,
    locale: "es-CO",
    timezoneId: "America/Bogota",
    trace: "retain-on-failure",
    // WebGL por software para MapLibre en el navegador sin GPU.
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    // `pnpm run build` (no `next build` a secas): incluye la copia del worker de MapLibre.
    command: `pnpm run build && pnpm exec next start --hostname ${E2E_HOST} --port ${E2E_WEB_PORT}`,
    url: `${WEB_URL}/login`,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      NEXT_PUBLIC_FLEET_API_URL: FLEET_API_URL,
      NEXT_PUBLIC_AGENT_URL: AGENT_URL,
      NEXT_DIST_DIR: ".next-e2e",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
