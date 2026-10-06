/**
 * Clasificación de un fallo al persistir (regla 7 de CLAUDE.md). FALLA EN CERRADO:
 * - `permanent`: SOLO lo atribuible a la fila, es decir un SQLSTATE de clase `22` (excepción de datos: fecha fuera de rango,
 *   número fuera de rango, texto inválido...) o `23` (violación de integridad: NOT NULL, CHECK, FK...). Reintentar el mismo
 *   pedido da el mismo error, y el mensaje sí es el culpable: se aísla y va a la DLQ.
 * - `transient`: todo lo demás, incluido lo desconocido y lo que no trae código. Conexión rechazada o cortada, base arrancando
 *   tras un reinicio (`57P03`), tiempo agotado (`57014`), disco lleno (`53100`), permiso o tabla ausentes por un despliegue
 *   fallido (`42501`, `42P01`), credenciales rotadas (`28P01`)... Se reintenta el MISMO pedido y, si se agotan los reintentos,
 *   el error sube: no se confirma el offset y la partición se detiene con un log de error.
 *
 * Por qué así: la alternativa (todo lo no reconocido como transitorio es permanente) vaciaba el backlog en la DLQ con el offset
 * confirmado cuando la causa era la base y no el mensaje, y el móvil ya había borrado esos puntos al recibir el 202. Detener una
 * partición es reversible (se arregla la causa y se reanuda); perder datos aceptados, no.
 */
export type FailureKind = "transient" | "permanent";

/**
 * Códigos de red de Node. Ya no deciden la clasificación (todo lo que no es de la fila es transitorio); solo se reconocen para
 * que `describeFailure` los nombre en la DLQ y los logs.
 */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Clases SQLSTATE atribuibles a la fila: `22` excepción de datos y `23` violación de integridad. */
const ROW_ATTRIBUTABLE_CLASSES: readonly string[] = ["22", "23"];

const MAX_CAUSE_DEPTH = 5;

function codeOf(error: object): string | undefined {
  return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** El error y todo lo que lo explica: su cadena de `cause` y, en un `AggregateError`, cada error agregado. */
function* explanations(error: unknown, depth = 0): Generator<object> {
  if (typeof error !== "object" || error === null || depth > MAX_CAUSE_DEPTH) return;
  yield error;
  if ("cause" in error) yield* explanations(error.cause, depth + 1);
  if ("errors" in error && Array.isArray(error.errors)) {
    for (const inner of error.errors) yield* explanations(inner, depth + 1);
  }
}

function isRowAttributable(error: object): boolean {
  const code = codeOf(error);
  return code !== undefined && SQLSTATE.test(code) && ROW_ATTRIBUTABLE_CLASSES.some((sqlstateClass) => code.startsWith(sqlstateClass));
}

export function classifyFailure(error: unknown): FailureKind {
  for (const candidate of explanations(error)) if (isRowAttributable(candidate)) return "permanent";
  return "transient";
}

/**
 * Descripción de un fallo SIN datos personales, para el `reason.message` de la DLQ y los logs: solo el código (SQLSTATE o
 * de red). Nunca el mensaje ni el detalle del error: un error de `pg` puede citar la fila.
 */
export function describeFailure(error: unknown): string {
  for (const candidate of explanations(error)) {
    const code = codeOf(candidate);
    if (code !== undefined && (SQLSTATE.test(code) || NETWORK_CODES.has(code))) return `código ${code}`;
  }
  return "error sin código";
}
