import { databaseConfig, kafkaConfig, loadConfig, logConfig, shutdownConfig, type Env } from "@fleet/platform";
import { z } from "zod";

const processorConfig = z.object({
  /**
   * Consumer group de `telemetry.raw`. Las réplicas del processor lo comparten (cada partición la lee una sola
   * réplica). El e2e usa uno propio para no competir con el `pnpm dev` de nadie. Mismo formato que el correlationId:
   * sin espacios ni saltos de línea, porque acaba en logs y en el broker.
   */
  PROCESSOR_CONSUMER_GROUP: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,128}$/, "1 a 128 caracteres de [A-Za-z0-9._-]")
    .default("processor"),
  /**
   * Intentos totales por operación de persistencia ante un fallo TRANSITORIO de la base (el primero cuenta). Agotados,
   * no va a la DLQ: el error sube, no se confirma el offset y kafkajs reentrega.
   */
  PROCESSOR_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  /** Espera de referencia antes del primer reintento, en ms. Crece x2 en cada reintento, con jitter. */
  PROCESSOR_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().min(10).max(60_000).default(200),
  /** Tope de la espera entre reintentos, en ms. Debe ser mayor o igual que el inicial. */
  PROCESSOR_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(10).max(300_000).default(5_000),
  /**
   * Mensajes por tramo de un lote de Kafka: cada tramo es un INSERT y, al persistirlo, se resuelve su offset y late el
   * heartbeat. Un tramo más grande es menos viajes a la base; uno más chico, menos trabajo repetido si algo falla. Tope de 1000: la DLQ
   * del tramo se parte en sub-lotes por tamaño, pero un tramo enorme alarga cada intento y cada reentrega.
   */
  PROCESSOR_INSERT_CHUNK_SIZE: z.coerce.number().int().min(1).max(1_000).default(500),
  /** Tiempo máximo de la publicación en `telemetry.dlq`, en ms. Si se agota, no se confirma el offset del tramo. */
  PROCESSOR_DLQ_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8_000),
  /**
   * Tiempo máximo de la publicación en `vehicle.state` y `fleet.alerts`, en ms. Si se agota, no se confirma el offset del tramo: se
   * reentrega y se republica el estado vigente (los consumidores descartan los repetidos por `seq`).
   */
  PROCESSOR_EVENTS_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8_000),
  /**
   * Minutos que un vehículo debe llevar detenido (contra la hora del fix GPS, no la del servidor) dentro de una zona crítica para
   * levantar la alerta `critical_zone_stop`. El umbral es inclusivo. Por defecto 20.
   */
  ALERT_CRITICAL_STOP_MINUTES: z.coerce.number().int().min(1).max(1_440).default(20),
  /** Un punto con velocidad MENOR que esto (m/s) está detenido. Por defecto 0,5 (~1,8 km/h: ruido de un GPS quieto). */
  STOP_SPEED_THRESHOLD_MPS: z.coerce.number().positive().max(10).default(0.5),
  /** Sin velocidad en el punto, un desplazamiento MENOR que esto (m) respecto del punto previo cuenta como detenido. Por defecto 15. */
  STOP_DISPLACEMENT_THRESHOLD_M: z.coerce.number().positive().max(1_000).default(15),
});

export const configSchema = z
  .object({
    ...databaseConfig.shape,
    ...kafkaConfig.shape,
    ...logConfig.shape,
    ...shutdownConfig.shape,
    ...processorConfig.shape,
  })
  .refine((config) => config.PROCESSOR_RETRY_MAX_DELAY_MS >= config.PROCESSOR_RETRY_INITIAL_DELAY_MS, {
    path: ["PROCESSOR_RETRY_MAX_DELAY_MS"],
    error: "debe ser mayor o igual que PROCESSOR_RETRY_INITIAL_DELAY_MS",
  });
export type ProcessorConfig = z.output<typeof configSchema>;

/** Valida el entorno al arrancar (fail fast): `ConfigError` nombra cada variable con problema, nunca su valor. */
export function loadProcessorConfig(env?: Env): ProcessorConfig {
  return env === undefined ? loadConfig(configSchema) : loadConfig(configSchema, env);
}
