import {
  alertsResponseTolerantSchema,
  fleetSummarySchema,
  stoppedVehiclesResponseTolerantSchema,
  type BreakerState,
} from "@fleet/contracts";
import type { Logger } from "@fleet/platform";
import CircuitBreaker from "opossum";
import type { z } from "zod";
import type { FleetData, FleetResult, FleetUnavailableReason, UserContext } from "../application/ports.js";
import { CORRELATION_ID_HTTP_HEADER, SESSION_COOKIE_NAME } from "../domain/protocol.js";

export interface BreakerSettings {
  /** Tiempo máximo de una llamada a fleet-api, en ms. Superado, cuenta como fallo. */
  timeoutMs: number;
  /** Porcentaje de fallos, dentro de la ventana, a partir del cual se abre el circuito. */
  errorThresholdPercentage: number;
  /** Llamadas mínimas dentro de la ventana antes de que el circuito pueda abrirse. */
  volumeThreshold: number;
  /** Cuánto espera abierto antes de pasar a `halfOpen` y dejar pasar una prueba, en ms. */
  resetTimeoutMs: number;
  /** Ventana estadística, en ms. */
  rollingWindowMs: number;
}

export interface ResilientFleetClientOptions {
  /** URL base de fleet-api (sin credenciales). */
  baseUrl: string;
  breaker: BreakerSettings;
  /** `fetch` inyectable, para los tests. */
  fetch?: typeof fetch;
  logger?: Logger;
}

export interface ResilientFleetClient extends FleetData {
  /** Estado actual del circuito hacia fleet-api. */
  breakerState(): BreakerState;
  /** Libera los temporizadores del breaker (apagado ordenado). */
  shutdown(): void;
}

/** fleet-api respondió con un estado que no es 2xx. Los 4xx NO abren el circuito (ver `errorFilter`). */
export class FleetApiHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`fleet-api respondió ${status}`);
    this.name = "FleetApiHttpError";
    this.status = status;
  }
}

/** Una consulta a fleet-api ya armada. Lleva la sesión del usuario, que es lo que filtra por tenant en fleet-api. */
interface FleetRequest {
  readonly path: string;
  readonly query: string;
  readonly sessionToken: string;
  readonly correlationId: string;
}

/** Resultado del FALLBACK. No es un dato: es un marcador que dice que fleet-api no respondió, y por qué. */
class FleetUnavailable {
  readonly reason: FleetUnavailableReason;

  constructor(reason: FleetUnavailableReason) {
    this.reason = reason;
  }
}

/** Un 4xx es una respuesta válida de fleet-api (sesión vencida, petición inválida): no es un fallo de disponibilidad. */
const isClientError = (error: unknown): boolean => error instanceof FleetApiHttpError && error.status >= 400 && error.status < 500;

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function reasonOf(error: unknown): FleetUnavailableReason {
  if (codeOf(error) === "EOPENBREAKER") return "breaker_open";
  const timedOut = codeOf(error) === "ETIMEDOUT" || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
  return timedOut ? "timeout" : "upstream_error";
}

function stateOf(breaker: CircuitBreaker): BreakerState {
  if (breaker.opened) return "open";
  if (breaker.halfOpen) return "halfOpen";
  return "closed";
}

/**
 * Cliente de fleet-api con circuit breaker (regla 11 de CLAUDE.md). Es el patrón de todo cliente entre servicios:
 *
 * - **Un breaker por dependencia, creado UNA vez**: esta fábrica se llama una sola vez, en el composition root. Nunca por petición:
 *   un breaker nuevo por llamada no acumularía fallos y no abriría jamás.
 * - `timeout` por llamada y umbrales configurables.
 * - `errorFilter`: los 4xx no cuentan como fallo ni abren el circuito (fleet-api respondió; el problema es de la petición o de la
 *   sesión). Los 5xx, los timeouts y los errores de red sí.
 * - **Fallback explícito**: cuando el circuito está abierto, o la llamada falla, devuelve `unavailable` con el motivo. Nunca datos
 *   inventados ni cacheados con apariencia de reales.
 * - Sin reintentos: son lecturas que el agente puede repetir, y reintentar contra un servicio caído solo lo castiga.
 * - Reenvía la cookie de sesión DEL USUARIO (decisión aprobada 5): fleet-api filtra por tenant con ella. El agente no tiene
 *   credenciales propias con más alcance.
 */
export function createResilientFleetClient(options: ResilientFleetClientOptions): ResilientFleetClient {
  const doFetch = options.fetch ?? fetch;
  const base = new URL(options.baseUrl);

  const action = async (request: FleetRequest): Promise<unknown> => {
    const url = new URL(request.path, base);
    url.search = request.query;
    const response = await doFetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        // Solo la cookie de sesión verificada: no se reenvían otras cookies ni cabeceras del cliente.
        cookie: `${SESSION_COOKIE_NAME}=${request.sessionToken}`,
        [CORRELATION_ID_HTTP_HEADER]: request.correlationId,
      },
      // Con una redirección la cookie podría viajar a otro destino.
      redirect: "error",
      signal: AbortSignal.timeout(options.breaker.timeoutMs),
    });
    if (!response.ok) {
      // Se descarta el cuerpo: no se necesita y libera la conexión.
      await response.body?.cancel().catch(() => undefined);
      throw new FleetApiHttpError(response.status);
    }
    return response.json();
  };

  const breaker = new CircuitBreaker<[FleetRequest], unknown>(action, {
    name: "fleet-api",
    timeout: options.breaker.timeoutMs,
    errorThresholdPercentage: options.breaker.errorThresholdPercentage,
    volumeThreshold: options.breaker.volumeThreshold,
    resetTimeout: options.breaker.resetTimeoutMs,
    rollingCountTimeout: options.breaker.rollingWindowMs,
    errorFilter: isClientError,
  });
  breaker.fallback((_request: FleetRequest, error: unknown) => new FleetUnavailable(reasonOf(error)));

  const log = options.logger;
  // Cada fallo que cuenta para el circuito (los 4xx no llegan aquí): el motivo, nunca el mensaje del error.
  breaker.on("failure", (error: unknown) => log?.warn({ dependency: "fleet-api", reason: reasonOf(error) }, "Llamada a fleet-api fallida"));
  breaker.on("open", () => log?.warn({ dependency: "fleet-api" }, "Circuit breaker abierto"));
  breaker.on("halfOpen", () => log?.info({ dependency: "fleet-api" }, "Circuit breaker en halfOpen"));
  breaker.on("close", () => log?.info({ dependency: "fleet-api" }, "Circuit breaker cerrado"));

  async function call<S extends z.ZodType>(
    context: UserContext,
    path: string,
    query: URLSearchParams,
    schema: S,
  ): Promise<FleetResult<z.output<S>>> {
    const request: FleetRequest = { path, query: query.toString(), sessionToken: context.sessionToken, correlationId: context.correlationId };
    let body: unknown;
    try {
      body = await breaker.fire(request);
    } catch (error) {
      // Con el fallback, `fire` solo rechaza con un 4xx filtrado (o con un fallo del propio fallback, que no se espera).
      if (error instanceof FleetApiHttpError) return { kind: "rejected", status: error.status };
      return { kind: "unavailable", reason: "upstream_error" };
    }
    if (body instanceof FleetUnavailable) return { kind: "unavailable", reason: body.reason };

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      log?.warn({ dependency: "fleet-api", path }, "Respuesta de fleet-api con una estructura inesperada");
      return { kind: "unavailable", reason: "invalid_response" };
    }
    return { kind: "ok", data: parsed.data };
  }

  return {
    stoppedVehicles(context, query) {
      const params = new URLSearchParams({ minMinutes: String(query.minMinutes), limit: String(query.limit) });
      if (query.zoneKind !== undefined) params.set("zoneKind", query.zoneKind);
      return call(context, "/v1/vehicles/stopped", params, stoppedVehiclesResponseTolerantSchema);
    },
    fleetSummary(context) {
      return call(context, "/v1/summary", new URLSearchParams(), fleetSummarySchema);
    },
    activeAlerts(context, query) {
      return call(context, "/v1/alerts", new URLSearchParams({ status: "active", limit: String(query.limit) }), alertsResponseTolerantSchema);
    },
    breakerState: () => stateOf(breaker),
    shutdown: () => breaker.shutdown(),
  };
}
