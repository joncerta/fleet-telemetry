import { loadConfig, logConfig, sessionSecretConfig, shutdownConfig, type Env } from "@fleet/platform";
import { z } from "zod";

/** Modelo por defecto del agente real. */
export const DEFAULT_AGENT_MODEL = "claude-sonnet-5-5";
export const MODEL_PROVIDERS = ["anthropic", "scripted"] as const;

/** Un origen de CORS: `esquema://host[:puerto]`, sin ruta, sin comodín y con la forma canónica (como la envía el navegador en `Origin`). */
function isOrigin(value: string): boolean {
  if (value.includes("*") || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
}

const corsOrigins = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== ""),
  )
  .pipe(z.array(z.string().refine(isOrigin, { error: "cada origen debe ser esquema://host[:puerto], sin ruta ni comodín" })).min(1));

/** URL base de fleet-api: solo http(s), sin credenciales incrustadas (la identidad viaja en la cookie, no en la URL). */
const fleetApiUrl = z
  .url({ protocol: /^https?$/ })
  .refine((value) => !URL.canParse(value) || (new URL(value).username === "" && new URL(value).password === ""), { error: "la URL no debe llevar credenciales" });

const agentConfig = z.object({
  AGENT_HOST: z.string().min(1).default("127.0.0.1"),
  AGENT_PORT: z.coerce.number().int().min(1).max(65_535).default(4003),
  // Base de fleet-api: las rutas se resuelven contra ella.
  FLEET_API_URL: fleetApiUrl.default("http://127.0.0.1:4002"),
  // Orígenes de la web autorizados a llamar con la cookie de sesión. Lista explícita: nunca `*` (no vale con credenciales).
  AGENT_CORS_ORIGINS: corsOrigins.default(["http://localhost:3000"]),
  // `anthropic` = Claude real; `scripted` = modelo con guion, determinista, para tests y e2e (no necesita API key).
  AGENT_MODEL_PROVIDER: z.enum(MODEL_PROVIDERS).default("anthropic"),
  AGENT_MODEL: z.string().min(1).default(DEFAULT_AGENT_MODEL),
  // Puede venir vacía (el .env.example la deja así): solo importa con el proveedor real.
  ANTHROPIC_API_KEY: z.string().optional(),
  // Pasos (llamada al modelo + herramientas) permitidos por pregunta.
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(20).default(6),
  // Tiempo total de una pregunta, en ms.
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  // Saltos de proxy de confianza delante del servicio (el ALB = 1). Con 0 se ignora X-Forwarded-For.
  AGENT_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // Tope ALTO por IP contra floods (todas las rutas salvo /v1/chat y la salud).
  AGENT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000_000).default(600),
  AGENT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  // Preguntas por usuario y ventana: cada una cuesta una llamada al modelo.
  AGENT_USER_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000_000).default(20),
  AGENT_USER_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  // Circuit breaker hacia fleet-api.
  AGENT_FLEET_API_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3_000),
  AGENT_BREAKER_ERROR_THRESHOLD_PERCENTAGE: z.coerce.number().int().min(1).max(100).default(50),
  AGENT_BREAKER_VOLUME_THRESHOLD: z.coerce.number().int().min(1).max(1_000).default(5),
  AGENT_BREAKER_RESET_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(15_000),
  AGENT_BREAKER_ROLLING_WINDOW_MS: z.coerce.number().int().min(1_000).max(600_000).default(10_000),
});

export const configSchema = z
  .object({
    ...logConfig.shape,
    ...shutdownConfig.shape,
    ...sessionSecretConfig.shape,
    ...agentConfig.shape,
  })
  .superRefine((config, context) => {
    // El proveedor real exige la clave; el de guion no la usa.
    if (config.AGENT_MODEL_PROVIDER === "anthropic" && (config.ANTHROPIC_API_KEY === undefined || config.ANTHROPIC_API_KEY === "")) {
      context.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "ANTHROPIC_API_KEY es obligatoria con AGENT_MODEL_PROVIDER=anthropic" });
    }
  });
export type AgentConfig = z.output<typeof configSchema>;

/** Valida el entorno al arrancar (fail fast): `ConfigError` nombra cada variable con problema, nunca su valor. */
export function loadAgentConfig(env?: Env): AgentConfig {
  return env === undefined ? loadConfig(configSchema) : loadConfig(configSchema, env);
}
