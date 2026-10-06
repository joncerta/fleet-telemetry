import { apiErrorSchema } from "@fleet/contracts";
import type { z } from "zod";
import type { LogFn } from "../log";

/** La API respondió 401: no hay sesión (o venció). Lleva al login. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Sesión ausente o vencida.");
    this.name = "UnauthorizedError";
  }
}

/** La API respondió un error con el cuerpo de `apiErrorSchema` (o sin él, si un proxy respondió antes). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Segundos de `Retry-After` (429), si la respuesta lo trae. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** No hubo respuesta: la API está caída, sin red o bloqueada por CORS. */
export class NetworkError extends Error {
  constructor() {
    super("No se pudo conectar con el servidor.");
    this.name = "NetworkError";
  }
}

/** La respuesta no cumple el contrato. Se descarta: nunca se muestra un dato que no validó. */
export class InvalidResponseError extends Error {
  constructor(readonly path: string) {
    super("La respuesta del servidor no tiene el formato esperado.");
    this.name = "InvalidResponseError";
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpClient {
  /**
   * `GET`/`POST` con la cookie de sesión. Valida la respuesta con `schema`; con `schema: null` espera una respuesta sin cuerpo (204).
   * `acceptStatuses`: estados no 2xx cuyo cuerpo el contrato define igual que el de éxito (p. ej. el `503` de un `/health` degradado);
   * se validan con `schema` en vez de tratarse como error.
   */
  request<S extends z.ZodType | null>(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown; schema: S; signal?: AbortSignal; acceptStatuses?: readonly number[] },
  ): Promise<S extends z.ZodType ? z.output<S> : undefined>;
}

export interface HttpClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  /** Registro de errores SIN datos personales: solo ruta y motivo. */
  logError?: LogFn;
}

function retryAfterOf(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

/**
 * Cliente HTTP de las APIs (fleet-api y el agente). Siempre `credentials: "include"` (la sesión es una cookie HttpOnly de otro origen) y
 * `cache: "no-store"` (son datos en vivo). Nunca envía `tenantId`: lo pone el servidor desde la sesión.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const logError = options.logError ?? (() => undefined);

  return {
    async request(path, { method = "GET", body, schema, signal, acceptStatuses = [] }) {
      let response: Response;
      try {
        response = await doFetch(`${options.baseUrl}${path}`, {
          method,
          credentials: "include",
          cache: "no-store",
          headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (isAbort(error)) throw error;
        throw new NetworkError();
      }

      if (response.status === 401) throw new UnauthorizedError();

      if (!response.ok && !acceptStatuses.includes(response.status)) {
        const parsed = apiErrorSchema.safeParse(await readJson(response));
        const code = parsed.success ? parsed.data.error.code : `http_${response.status}`;
        const message = parsed.success ? parsed.data.error.message : `Error ${response.status} del servidor.`;
        throw new ApiRequestError(response.status, code, message, retryAfterOf(response));
      }

      if (schema === null) return undefined as never;

      const parsed = schema.safeParse(await readJson(response));
      if (!parsed.success) {
        // Solo las rutas de los campos inválidos: nunca los valores (pueden ser posiciones o placas).
        logError("Respuesta inválida de la API", { path, issues: parsed.error.issues.map((issue) => issue.path.join(".")) });
        throw new InvalidResponseError(path);
      }
      return parsed.data as never;
    },
  };
}
