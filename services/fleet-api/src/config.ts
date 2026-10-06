import { randomUUID } from "node:crypto";
import { databaseConfig, kafkaConfig, loadConfig, logConfig, sessionSecretConfig, shutdownConfig, type Env } from "@fleet/platform";
import { z } from "zod";

/**
 * Máximo de `SSE_HEARTBEAT_MS`. El idle timeout del ALB en Terraform es de 120 s y exige al menos 2 latidos de margen antes de que
 * lo alcance, así que el latido no puede superar los 30 s (con 30 s caben 4 dentro de los 120 s).
 */
export const MAX_SSE_HEARTBEAT_MS = 30_000;

const MAX_SESSION_TTL_HOURS = 24 * 30;

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

/** `true` / `false` explícitos: `z.coerce.boolean()` leería "false" como verdadero (cualquier texto no vacío lo es). */
const booleanFlag = z.enum(["true", "false"]).transform((value) => value === "true");

const fleetApiConfig = z.object({
  FLEET_API_HOST: z.string().min(1).default("127.0.0.1"),
  FLEET_API_PORT: z.coerce.number().int().min(1).max(65_535).default(4002),
  // Cuánto dura una sesión desde el login, en horas.
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(MAX_SESSION_TTL_HOURS).default(12),
  // Orígenes de la web autorizados a llamar con la cookie de sesión. Lista explícita: nunca `*` (no vale con credenciales).
  FLEET_API_CORS_ORIGINS: corsOrigins.default(["http://localhost:3000"]),
  // `Secure` de la cookie de sesión: false solo en local (http); en cualquier despliegue con TLS debe ser true.
  FLEET_API_COOKIE_SECURE: booleanFlag.default(false),
  // Latido del stream SSE: acotado por el idle timeout del ALB.
  SSE_HEARTBEAT_MS: z.coerce.number().int().min(1_000).max(MAX_SSE_HEARTBEAT_MS).default(15_000),
  // Reconexión del cliente SSE (`retry:` del primer frame): base en ms más un jitter aleatorio de 0 a SSE_RETRY_JITTER_MS, para que un reinicio no
  // provoque una estampida de reconexiones.
  SSE_RETRY_MS: z.coerce.number().int().min(1_000).max(120_000).default(3_000),
  SSE_RETRY_JITTER_MS: z.coerce.number().int().min(0).max(120_000).default(5_000),
  // Conexiones SSE NUEVAS por usuario y ventana (cada una lee un snapshot de la base). Superado: 429 con Retry-After.
  SSE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(30),
  SSE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  // Conexiones del pool PROPIO que lee los snapshots del SSE (no compite con el pool de la API REST).
  SSE_SNAPSHOT_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),
  // Identidad de ESTA réplica en el consumer group del SSE (`fleet-api-sse-<id>`): cada réplica necesita un grupo propio para recibir todos los
  // eventos. Por defecto un uuid nuevo por proceso (el grupo no sobrevive al proceso). Solo `[A-Za-z0-9._-]`, hasta 64 caracteres.
  FLEET_API_INSTANCE_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, { error: "debe ser de 1 a 64 caracteres de [A-Za-z0-9._-]" })
    .default(() => randomUUID()),
  // Streams SSE simultáneos por usuario en cada réplica; el siguiente recibe 429.
  SSE_MAX_STREAMS_PER_USER: z.coerce.number().int().min(1).max(100).default(5),
  // Bytes sin leer en el socket de un stream a partir de los cuales el cliente se da por lento y se le corta (reconecta y recibe un snapshot nuevo).
  SSE_MAX_PENDING_BYTES: z.coerce.number().int().min(65_536).max(67_108_864).default(4_194_304),
  // Saltos de proxy de confianza delante del servicio (el ALB = 1). Con 0 se ignora X-Forwarded-For. Mal configurado, los límites por IP
  // se vuelven globales (se ve la IP del balanceador) o se dejan falsear.
  FLEET_API_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // Tope ALTO por IP contra floods: cuenta todas las peticiones, antes de autenticar.
  FLEET_API_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000_000).default(600),
  FLEET_API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  // Login: fallos permitidos por ventana, contados por IP y por correo (el correo, hasheado). Superado: 429 con Retry-After.
  FLEET_API_LOGIN_FAILURE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000_000).default(10),
  FLEET_API_LOGIN_FAILURE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(900_000),
  // Canje de código de vinculación (sin sesión): fallos permitidos por IP y ventana. El código son 40 bits: el límite es estricto.
  FLEET_API_PAIR_FAILURE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000_000).default(10),
  FLEET_API_PAIR_FAILURE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(900_000),
  // Vida de un código de vinculación, en minutos.
  FLEET_API_PAIRING_CODE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
});

export const configSchema = z.object({
  ...databaseConfig.shape,
  ...kafkaConfig.shape,
  ...logConfig.shape,
  ...shutdownConfig.shape,
  ...sessionSecretConfig.shape,
  ...fleetApiConfig.shape,
});
export type FleetApiConfig = z.output<typeof configSchema>;

/** Valida el entorno al arrancar (fail fast): `ConfigError` nombra cada variable con problema, nunca su valor. */
export function loadFleetApiConfig(env?: Env): FleetApiConfig {
  return env === undefined ? loadConfig(configSchema) : loadConfig(configSchema, env);
}
