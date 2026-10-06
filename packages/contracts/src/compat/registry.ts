import { healthResponseSchema } from "../health.js";
import {
  apiErrorSchema,
  batchAckSchema,
  batchAckTolerantSchema,
  deviceTokenSchema,
  telemetryBatchEnvelopeSchema,
  telemetryDlqMessageSchema,
  telemetryDlqMessageTolerantSchema,
  telemetryPointSchema,
  telemetryRawEventSchema,
} from "../telemetry.js";
import type { ContractEntry } from "./harness.js";

/** `originalPayload` es `z.json()` (JSON opaco y requerido): no tiene un objeto de esquema donde inyectar un campo extra. */
const OPAQUE_JSON_PAYLOAD = {
  reason: "originalPayload es JSON opaco (z.json(), lazy): es el valor original del mensaje y no define campos que una versión posterior pueda ampliar.",
} as const;

/**
 * Registro de contratos versionados. Cada esquema de `@fleet/contracts` que cruza un límite (HTTP, Kafka,
 * SSE, herramienta del agente) se agrega aquí con todas sus versiones publicadas, y cada versión tiene su
 * fixture en `fixtures/<name>/v<N>.json`.
 *
 * `N` es la versión del CABLE (el `schemaVersion` que viaja en el mensaje), no un contador de ediciones del esquema.
 * Mientras no exista un consumidor real todo es v1 (ver el encabezado de `telemetry.ts`); desde que exista, un motivo o
 * código nuevo en un enum estrictamente validado implica una versión nueva y su fixture.
 *
 * Un contrato con una unión simple, una intersección o un `lazy` que contenga un objeto JSON no se puede verificar hacia
 * adelante: el arnés lo reporta. Se modela con `z.object` o `z.discriminatedUnion`, o se registra con
 * `forwardCompatExemption: { reason }` (motivo obligatorio, visible en la revisión).
 *
 * El arnés está probado con esquemas locales en `harness.test.ts`.
 */
export const contractRegistry: readonly ContractEntry[] = [
  { name: "telemetry-point", schema: telemetryPointSchema, versions: [1] },
  { name: "telemetry-batch-envelope", schema: telemetryBatchEnvelopeSchema, versions: [1] },
  { name: "telemetry-raw-event", schema: telemetryRawEventSchema, versions: [1] },
  { name: "batch-ack", schema: batchAckSchema, versions: [1] },
  { name: "batch-ack-tolerant", schema: batchAckTolerantSchema, versions: [1] },
  { name: "telemetry-dlq-message", schema: telemetryDlqMessageSchema, versions: [1], forwardCompatExemption: OPAQUE_JSON_PAYLOAD },
  { name: "telemetry-dlq-message-tolerant", schema: telemetryDlqMessageTolerantSchema, versions: [1], forwardCompatExemption: OPAQUE_JSON_PAYLOAD },
  { name: "device-token", schema: deviceTokenSchema, versions: [1] },
  { name: "api-error", schema: apiErrorSchema, versions: [1] },
  { name: "health-response", schema: healthResponseSchema, versions: [1] },
];
