import type { Page } from "@playwright/test";
import { NORTE_USER } from "./support/env";
import { expect, login, test } from "./support/fixtures";

/** Abre el asistente y devuelve su panel. */
async function openAssistant(page: Page) {
  await page.getByRole("button", { name: "Asistente IA" }).click();
  const panel = page.getByRole("region", { name: "Asistente IA" });
  await expect(panel).toBeVisible();
  return panel;
}

async function ask(page: Page, question: string) {
  const panel = page.getByRole("region", { name: "Asistente IA" });
  await panel.getByLabel("Tu pregunta").fill(question);
  await panel.getByRole("button", { name: "Preguntar" }).click();
}

test.describe("chat con el agente IA", () => {
  test("una pregunta muestra la respuesta y las consultas (toolCalls) que hizo el agente", async ({ page, env, stack: _stack }) => {
    await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
    const panel = await openAssistant(page);
    // Al abrir, el estado del breaker sale de /health del agente.
    await expect(panel.getByText("Datos de la flota disponibles.")).toBeVisible();

    await ask(page, "¿Qué vehículos llevan más de 20 minutos detenidos en zonas críticas?");
    const toolCalls = panel.getByRole("list", { name: "Consultas del asistente" });
    await expect(toolCalls.getByRole("listitem").filter({ hasText: "get_stopped_vehicles" })).toContainText("correcta");
    await expect(toolCalls).toContainText('zoneKind: "critical"');
    // La respuesta del modelo con guion sale de los datos reales de la herramienta (Norte), nunca inventada.
    await expect(panel.getByText(/vehículos? detenidos?|No hay vehículos detenidos/)).toBeVisible();
    await expect(panel.getByText(/SUR\d{3}/)).toHaveCount(0);
  });

  test("con fleet-api detenido, el chat muestra el breaker abierto y no inventa datos", async ({ page, env, stack }) => {
    await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
    const panel = await openAssistant(page);

    await stack.stopFleetApi();
    try {
      // Cada pregunta falla hacia fleet-api; tras unas cuantas el breaker del agente se abre y la respuesta lo trae.
      await expect(async () => {
        await ask(page, "Dame el resumen de la flota");
        await expect(panel.getByText("Datos de la flota no disponibles", { exact: false })).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });

      await expect(panel.getByRole("list", { name: "Consultas del asistente" }).getByRole("listitem").first()).toContainText("falló");
      // Sin datos: ni cifras de la flota ni placas.
      await expect(panel.getByText(/La flota tiene \d+ vehículos/)).toHaveCount(0);
      await expect(panel.getByText(/NRT\d{3}/)).toHaveCount(0);
    } finally {
      await stack.startFleetApi();
    }
  });
});
