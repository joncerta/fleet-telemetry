import { databaseConfig, kafkaConfig, loadConfig } from "@fleet/platform";
import { z } from "zod";

/**
 * Variables del e2e de la web (las mismas del `.env` de la raíz, que `playwright.config.ts` carga sin pisar las ya definidas). Si falta
 * alguna, falla con su nombre: nunca se salta un test.
 */
export const e2eEnvSchema = z.object({
  ...databaseConfig.shape,
  ...kafkaConfig.shape,
  /** Contraseña de los usuarios de demo (`pnpm db:seed`). */
  SEED_USER_PASSWORD: z.string().min(12),
});
export type E2eEnv = z.output<typeof e2eEnvSchema>;

export const loadE2eEnv = (): E2eEnv => loadConfig(e2eEnvSchema);

/** Puertos propios del e2e de la web: distintos del `pnpm dev` (3000/4001-4003) y del e2e del backend (14001-14003). */
export const E2E_HOST = "127.0.0.1";
export const E2E_WEB_PORT = 33000;
export const E2E_GATEWAY_PORT = 34001;
export const E2E_FLEET_API_PORT = 34002;
export const E2E_AGENT_PORT = 34003;

// El mismo host en la web y en las APIs: la cookie `SameSite=Lax` de fleet-api solo viaja entre orígenes del mismo sitio.
export const WEB_URL = `http://${E2E_HOST}:${E2E_WEB_PORT}`;
export const GATEWAY_URL = `http://${E2E_HOST}:${E2E_GATEWAY_PORT}`;
export const FLEET_API_URL = `http://${E2E_HOST}:${E2E_FLEET_API_PORT}`;
export const AGENT_URL = `http://${E2E_HOST}:${E2E_AGENT_PORT}`;

/** Usuarios sembrados por `pnpm db:seed` (tools/dev-data). */
export const NORTE_USER = "operador@norte.test";
export const SUR_USER = "operador@sur.test";
