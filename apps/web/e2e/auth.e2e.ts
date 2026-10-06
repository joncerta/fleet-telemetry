import { NORTE_USER } from "./support/env";
import { expect, login, test } from "./support/fixtures";

test.describe("sesión", () => {
  test("sin sesión, el dashboard lleva al login", async ({ page, stack: _stack }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Ingresa al portal" })).toBeVisible();
  });

  test("una contraseña incorrecta muestra un error genérico y no entra", async ({ page, stack: _stack }) => {
    await page.goto("/login");
    await page.getByLabel("Correo").fill(NORTE_USER);
    await page.getByLabel("Contraseña").fill("contraseña-equivocada");
    await page.getByRole("button", { name: "Ingresar" }).click();
    await expect(page.getByRole("form", { name: "Ingreso" }).getByRole("alert")).toHaveText("Correo o contraseña incorrectos.");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("login con email y contraseña, y logout", async ({ page, env, stack: _stack }) => {
    await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("banner")).toContainText("Flota Norte");

    await page.getByRole("button", { name: "Cerrar sesión" }).click();
    await expect(page).toHaveURL(/\/login$/);
    // La cookie se borró: volver al dashboard pide login otra vez.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });
});
