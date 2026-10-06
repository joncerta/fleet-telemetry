import { z } from "zod";
import type { AlertCursor } from "../../application/ports.js";

/** El cursor recibido no es uno que este servicio haya emitido (manipulado, truncado o de otra versión). */
export class InvalidCursorError extends Error {
  constructor() {
    super("Cursor de paginación inválido.");
    this.name = "InvalidCursorError";
  }
}

/** Versión del formato del cursor, dentro del propio cursor: permite cambiarlo sin aceptar uno viejo con otra interpretación. */
const VERSION = 1;

/** `raisedAt` con microsegundos exactos (`YYYY-MM-DDTHH:MM:SS.ffffffZ`): la precisión de `timestamptz`, que un `Date` pierde. */
const MICROSECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const cursorPayload = z.object({
  v: z.literal(VERSION),
  r: z.string().regex(MICROSECOND_UTC).refine((value) => !Number.isNaN(Date.parse(value)), { error: "fecha inexistente" }),
  a: z.uuid(),
});

/**
 * Cursor OPACO de `GET /v1/alerts`: base64url de un JSON `{v, r, a}` (versión, `raisedAt` y `alertId` de la última alerta devuelta). No
 * va firmado: no es un límite de seguridad (la consulta filtra siempre por el tenant de la sesión; un cursor manipulado solo
 * cambia desde dónde se pagina dentro de los datos del propio tenant). Sí se valida estrictamente antes de llegar a SQL.
 */
export function encodeAlertCursor(cursor: AlertCursor): string {
  return Buffer.from(JSON.stringify({ v: VERSION, r: cursor.raisedAt, a: cursor.alertId }), "utf8").toString("base64url");
}

/** Decodifica un cursor emitido por `encodeAlertCursor`; lanza `InvalidCursorError` ante cualquier otra cosa. */
export function decodeAlertCursor(value: string): AlertCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = cursorPayload.safeParse(decoded);
  if (!parsed.success) throw new InvalidCursorError();
  return { raisedAt: parsed.data.r, alertId: parsed.data.a };
}
