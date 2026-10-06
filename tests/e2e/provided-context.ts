import "vitest";

// Valores que `global-setup.ts` entrega a los tests con `provide()`; se leen con `inject()` de vitest.
declare module "vitest" {
  export interface ProvidedContext {
    /** Identificador de la corrida: aísla los datos de cada ejecución. */
    runId: string;
    /** Base URL del ingest-gateway que levantó el arnés (puerto propio del e2e). */
    gatewayUrl: string;
    /** Base URL de fleet-api que levantó el arnés (puerto propio del e2e). */
    fleetApiUrl: string;
    /** Base URL del agente que levantó el arnés (puerto propio del e2e, modelo con guion). */
    agentUrl: string;
    /** Servidor de control del arnés (parar y volver a levantar un servicio) y su token: usa `service-control.ts`. */
    controlUrl: string;
    controlToken: string;
    /** Fin de cada partición de telemetry.raw (partición -> offset) cuando se ancló el grupo del processor: no lee nada anterior. */
    rawBacklogEnd: Record<string, string>;
    /** Consumer group del processor del e2e. */
    processorGroup: string;
    /** Carpeta con los logs de los servicios de esta corrida. */
    serviceLogDir: string;
  }
}
