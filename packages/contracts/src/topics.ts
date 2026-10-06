/**
 * Nombres de los tópicos de Kafka. Los crea infra (`redpanda-init` en local, Terraform en AWS): ningún servicio los
 * crea. La key de todos es `vehicleId` (ver `infra/CLAUDE.md`).
 */
export const TOPICS = {
  /** Telemetría validada por el gateway. Productor: `ingest-gateway`. Consumidor: `processor`. */
  telemetryRaw: "telemetry.raw",
  /** Mensajes inválidos o que agotaron reintentos. Productores: `ingest-gateway` y `processor`. */
  telemetryDlq: "telemetry.dlq",
  /** Estado actual de cada vehículo. Productor: `processor`. Consumidor: `fleet-api`. */
  vehicleState: "vehicle.state",
  /** Alertas de la flota. Productor: `processor`. Consumidor: `fleet-api`. */
  fleetAlerts: "fleet.alerts",
} as const;
export type Topic = (typeof TOPICS)[keyof typeof TOPICS];
