import type { ContractEntry } from "./harness.js";

/**
 * Registro de contratos versionados. Cada esquema de `@fleet/contracts` que cruza un límite (HTTP, Kafka,
 * SSE, herramienta del agente) se agrega aquí con todas sus versiones publicadas, y cada versión tiene su
 * fixture en `fixtures/<name>/v<N>.json`.
 *
 * Vacío hasta la fase 1: el arnés está probado con esquemas locales en `harness.test.ts`.
 */
export const contractRegistry: readonly ContractEntry[] = [];
