import {
  agentHealthResponseSchema,
  agentHealthResponseTolerantSchema,
  chatRequestSchema,
  chatResponseSchema,
  chatResponseTolerantSchema,
} from "../agent.js";
import {
  alertEventSchema,
  alertEventTolerantSchema,
  alertSchema,
  alertsQuerySchema,
  alertsResponseSchema,
  alertsResponseTolerantSchema,
  alertTolerantSchema,
  devicePairRequestSchema,
  devicePairResponseSchema,
  devicePairResponseTolerantSchema,
  fleetSummarySchema,
  loginRequestSchema,
  pairingCodeCreateRequestSchema,
  pairingCodeSchema,
  sessionSchema,
  sseAlertSchema,
  sseAlertTolerantSchema,
  sseSnapshotSchema,
  sseSnapshotTolerantSchema,
  sseVehicleStateSchema,
  sseVehicleStateTolerantSchema,
  stoppedVehiclesQuerySchema,
  stoppedVehiclesResponseSchema,
  stoppedVehiclesResponseTolerantSchema,
  vehicleStateEventSchema,
  vehicleStateEventTolerantSchema,
  vehicleStateSchema,
  vehicleStateTolerantSchema,
  zoneFeatureCollectionSchema,
  zoneFeatureCollectionTolerantSchema,
} from "../fleet.js";
import { healthResponseSchema, livenessResponseSchema } from "../health.js";
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
  { name: "liveness-response", schema: livenessResponseSchema, versions: [1] },
  // Read model de la flota (fase 1b, fleet.ts): todo v1. Las variantes tolerantes tienen su propia entrada y su fixture.
  { name: "vehicle-state", schema: vehicleStateSchema, versions: [1] },
  { name: "vehicle-state-tolerant", schema: vehicleStateTolerantSchema, versions: [1] },
  { name: "vehicle-state-event", schema: vehicleStateEventSchema, versions: [1] },
  { name: "vehicle-state-event-tolerant", schema: vehicleStateEventTolerantSchema, versions: [1] },
  { name: "alert", schema: alertSchema, versions: [1] },
  { name: "alert-tolerant", schema: alertTolerantSchema, versions: [1] },
  { name: "alert-event", schema: alertEventSchema, versions: [1] },
  { name: "alert-event-tolerant", schema: alertEventTolerantSchema, versions: [1] },
  { name: "zone-feature-collection", schema: zoneFeatureCollectionSchema, versions: [1] },
  { name: "zone-feature-collection-tolerant", schema: zoneFeatureCollectionTolerantSchema, versions: [1] },
  { name: "fleet-summary", schema: fleetSummarySchema, versions: [1] },
  { name: "stopped-vehicles-query", schema: stoppedVehiclesQuerySchema, versions: [1] },
  { name: "stopped-vehicles-response", schema: stoppedVehiclesResponseSchema, versions: [1] },
  { name: "stopped-vehicles-response-tolerant", schema: stoppedVehiclesResponseTolerantSchema, versions: [1] },
  { name: "alerts-query", schema: alertsQuerySchema, versions: [1] },
  { name: "alerts-response", schema: alertsResponseSchema, versions: [1] },
  { name: "alerts-response-tolerant", schema: alertsResponseTolerantSchema, versions: [1] },
  { name: "sse-snapshot", schema: sseSnapshotSchema, versions: [1] },
  { name: "sse-snapshot-tolerant", schema: sseSnapshotTolerantSchema, versions: [1] },
  { name: "sse-vehicle-state", schema: sseVehicleStateSchema, versions: [1] },
  { name: "sse-vehicle-state-tolerant", schema: sseVehicleStateTolerantSchema, versions: [1] },
  { name: "sse-alert", schema: sseAlertSchema, versions: [1] },
  { name: "sse-alert-tolerant", schema: sseAlertTolerantSchema, versions: [1] },
  { name: "login-request", schema: loginRequestSchema, versions: [1] },
  { name: "session", schema: sessionSchema, versions: [1] },
  { name: "pairing-code-create-request", schema: pairingCodeCreateRequestSchema, versions: [1] },
  { name: "pairing-code", schema: pairingCodeSchema, versions: [1] },
  { name: "device-pair-request", schema: devicePairRequestSchema, versions: [1] },
  { name: "device-pair-response", schema: devicePairResponseSchema, versions: [1] },
  { name: "device-pair-response-tolerant", schema: devicePairResponseTolerantSchema, versions: [1] },
  // Agente (fase 1c, agent.ts): todo v1.
  { name: "chat-request", schema: chatRequestSchema, versions: [1] },
  { name: "chat-response", schema: chatResponseSchema, versions: [1] },
  { name: "chat-response-tolerant", schema: chatResponseTolerantSchema, versions: [1] },
  { name: "agent-health-response", schema: agentHealthResponseSchema, versions: [1] },
  { name: "agent-health-response-tolerant", schema: agentHealthResponseTolerantSchema, versions: [1] },
];
