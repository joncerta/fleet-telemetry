/**
 * Identidad de un dispositivo autenticado. Sale SOLO del token verificado (regla 4 de CLAUDE.md): nada del body, la
 * query ni los headers la alimenta.
 */
export interface DeviceContext {
  readonly tenantId: string;
  readonly deviceId: string;
  /** Único vehículo que este dispositivo puede reportar. */
  readonly vehicleId: string;
}
