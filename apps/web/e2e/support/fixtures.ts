import { assertStackAvailable } from "@fleet/platform/testing";
import { test as base, expect, type Page } from "@playwright/test";
import { loadE2eEnv, type E2eEnv } from "./env";
import { startStack, type E2eStack } from "./stack";
import { createFleetDriver, type FleetDriver } from "./telemetry";

/** Vehículos que el e2e mueve (los últimos de cada tenant: el resto queda libre para `pnpm simulate`). */
export const NORTE_LIVE = "NRT115";
export const NORTE_ALERT = "NRT114";
export const NORTE_ISOLATION = "NRT113";
export const SUR_LIVE = "SUR115";
const DRIVEN_PLATES = [NORTE_LIVE, NORTE_ALERT, NORTE_ISOLATION, SUR_LIVE];

/**
 * Estilo de mapa mínimo: el e2e no depende de los tiles de OpenFreeMap (red externa). Declara `glyphs` porque la capa de conteo de los
 * clústeres usa texto; esas peticiones se abortan como el resto.
 */
const BLANK_MAP_STYLE = { version: 8, name: "e2e", glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf", sources: {}, layers: [] };

interface WorkerFixtures {
  env: E2eEnv;
  stack: E2eStack;
  fleet: FleetDriver;
}

export const test = base.extend<{ page: Page }, WorkerFixtures>({
  env: [
    // Playwright exige desestructurar el primer argumento; se toma el fixture integrado `playwright` (sin usarlo) en vez de `{}`.
    async ({ playwright: _playwright }, use) => {
      await use(loadE2eEnv());
    },
    { scope: "worker" },
  ],
  stack: [
    async ({ env }, use) => {
      // Falla con un mensaje claro si TimescaleDB o Redpanda no responden: nunca se salta.
      await assertStackAvailable({ databaseAdminUrl: env.DATABASE_URL, kafkaBrokers: env.KAFKA_BROKERS });
      const stack = await startStack(env);
      try {
        await use(stack);
      } finally {
        await stack.stop();
      }
    },
    { scope: "worker", timeout: 120_000 },
  ],
  fleet: [
    async ({ env, stack }, use) => {
      const driver = await createFleetDriver(env, stack.gatewayUrl, DRIVEN_PLATES);
      try {
        await use(driver);
      } finally {
        await driver.close();
      }
    },
    { scope: "worker" },
  ],
  page: async ({ page }, use) => {
    await page.route("https://tiles.openfreemap.org/**", (route) =>
      route.request().url().includes("/styles/") ? route.fulfill({ json: BLANK_MAP_STYLE }) : route.abort(),
    );
    await use(page);
  },
});

export { expect };

/** Ingresa por el formulario (como un usuario) y espera el dashboard. */
export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fleet Telemetry" })).toBeVisible();
}

/**
 * Envía puntos del vehículo hasta que su fila muestre `text`, sin recargar. Solo para el PRIMER evento tras arrancar o reiniciar fleet-api:
 * su consumidor de Kafka tarda unos segundos en unirse al grupo y un evento producido antes no le llega. Después, un envío basta.
 */
export async function sendUntilShown(page: Page, fleet: FleetDriver, plate: string, point: Parameters<FleetDriver["send"]>[1], text: string): Promise<void> {
  await expect(async () => {
    await fleet.send(plate, point);
    await expect(vehicleItem(page, plate)).toContainText(text, { timeout: 4_000 });
  }).toPass({ timeout: 60_000 });
}

export const connectionStatus = (page: Page) => page.getByRole("status").filter({ hasText: "Conexión:" });
export const vehicleList = (page: Page) => page.getByRole("list", { name: "Vehículos" });
export const vehicleItem = (page: Page, plate: string) => vehicleList(page).getByRole("listitem").filter({ hasText: plate });
export const alertList = (page: Page) => page.getByRole("list", { name: "Alertas" });
