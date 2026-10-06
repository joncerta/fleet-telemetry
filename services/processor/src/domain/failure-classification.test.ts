import { describe, expect, it } from "vitest";
import { classifyFailure, describeFailure } from "./failure-classification.js";

const withCode = (code: string, message = "fallo") => Object.assign(new Error(message), { code });

// Falla en cerrado: solo es permanente lo atribuible a la fila (SQLSTATE de clase 22 o 23). Todo lo demás, incluido lo que no se
// reconoce, es transitorio: se reintenta y, agotados los reintentos, la partición se detiene. Es preferible a vaciar el tópico
// en la DLQ (con el offset confirmado, el móvil ya borró esos puntos) cuando la causa es la base y no el mensaje.
describe("classifyFailure", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND"])(
    "el código de red %s es transitorio",
    (code) => {
      expect(classifyFailure(withCode(code))).toBe("transient");
    },
  );

  it.each([
    ["08000", "connection_exception"],
    ["08003", "connection_does_not_exist"],
    ["08006", "connection_failure"],
    ["08P01", "protocol_violation"],
    ["57P01", "admin_shutdown"],
    ["53300", "too_many_connections"],
    ["40001", "serialization_failure"],
    ["40P01", "deadlock_detected"],
  ])("el SQLSTATE %s (%s) es transitorio", (code) => {
    expect(classifyFailure(withCode(code))).toBe("transient");
  });

  it.each([
    "Connection terminated unexpectedly",
    "Connection terminated due to connection timeout",
    "timeout exceeded when trying to connect",
    "Client has encountered a connection error and is not queryable",
    "Client was closed and is not queryable",
  ])("el error de pg sin código %j (conexión perdida) es transitorio", (message) => {
    expect(classifyFailure(new Error(message))).toBe("transient");
  });

  // Lo que antes caía en "permanente" y vaciaba el backlog en la DLQ: la base arrancando tras un reinicio (57P03), una
  // cancelación por tiempo (57014), un permiso o un esquema mal desplegados, credenciales rotadas, disco lleno...
  // La corrección de la aserción que fijaba 57014 como permanente no debilita el test: esa aserción era el defecto.
  it.each([
    ["57014", "query_canceled"],
    ["57P03", "cannot_connect_now (la base arrancando tras un reinicio)"],
    ["25006", "read_only_sql_transaction"],
    ["42501", "insufficient_privilege"],
    ["42P01", "undefined_table"],
    ["42703", "undefined_column"],
    ["3D000", "invalid_catalog_name"],
    ["28P01", "invalid_password"],
    ["28000", "invalid_authorization_specification"],
    ["53100", "disk_full"],
    ["53200", "out_of_memory"],
    ["XX000", "internal_error"],
  ])("el SQLSTATE %s (%s) NO es atribuible a la fila: es transitorio", (code) => {
    expect(classifyFailure(withCode(code))).toBe("transient");
  });

  it("un error sin código es transitorio", () => {
    expect(classifyFailure(new Error("algo raro"))).toBe("transient");
  });

  it("lo que no es un error (texto, undefined, null, número) es transitorio", () => {
    expect(classifyFailure("texto")).toBe("transient");
    expect(classifyFailure(undefined)).toBe("transient");
    expect(classifyFailure(null)).toBe("transient");
    expect(classifyFailure(42)).toBe("transient");
  });

  it.each([
    ["22003", "numeric_value_out_of_range"],
    ["22007", "invalid_datetime_format"],
    ["22008", "datetime_field_overflow"],
    ["22P02", "invalid_text_representation"],
    ["22001", "string_data_right_truncation"],
    ["23502", "not_null_violation"],
    ["23503", "foreign_key_violation"],
    ["23514", "check_violation"],
    ["23505", "unique_violation"],
  ])("el SQLSTATE %s (%s), atribuible a la fila (clase 22 o 23), es permanente", (code) => {
    expect(classifyFailure(withCode(code))).toBe("permanent");
  });

  it("una clase 08 que no es un SQLSTATE válido (otro formato) es transitoria como todo lo demás", () => {
    expect(classifyFailure(withCode("08"))).toBe("transient");
    expect(classifyFailure(withCode("08xyz"))).toBe("transient");
  });

  it("un código que empieza con 22 o 23 pero no es un SQLSTATE (largo o formato distinto) no se toma por un error de la fila", () => {
    expect(classifyFailure(withCode("22"))).toBe("transient");
    expect(classifyFailure(withCode("2200"))).toBe("transient");
    expect(classifyFailure(withCode("22008X"))).toBe("transient");
    expect(classifyFailure(withCode("22abc"))).toBe("transient");
  });

  it("mira la causa: un error envuelto cuya causa es transitoria es transitorio", () => {
    const wrapped = new Error("no se pudo guardar", { cause: withCode("ECONNRESET") });

    expect(classifyFailure(wrapped)).toBe("transient");
  });

  it("mira la causa: un error envuelto cuya causa es de la fila (clase 22) es permanente", () => {
    expect(classifyFailure(new Error("envoltorio", { cause: withCode("22008") }))).toBe("permanent");
  });

  it("mira los errores de un AggregateError (la conexión a localhost prueba ::1 y 127.0.0.1)", () => {
    const aggregate = new AggregateError([withCode("ECONNREFUSED"), withCode("ECONNREFUSED")], "");

    expect(classifyFailure(aggregate)).toBe("transient");
  });

  it("no se cuelga con una cadena de causas circular, y sin ningún código de fila es transitoria", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b", { cause: a });
    a.cause = b;

    expect(classifyFailure(a)).toBe("transient");
  });
});

describe("describeFailure", () => {
  it("devuelve solo el código, nunca el mensaje (un error de pg puede citar la fila)", () => {
    const error = withCode("22003", 'value "-75.5636" is out of range, Failing row contains (6.2518)');

    const description = describeFailure(error);

    expect(description).toBe("código 22003");
    expect(description).not.toMatch(/75\.5636|6\.2518|Failing/);
  });

  it("describe el código de red y el de una causa", () => {
    expect(describeFailure(withCode("ECONNREFUSED"))).toBe("código ECONNREFUSED");
    expect(describeFailure(new Error("envoltorio", { cause: withCode("40P01") }))).toBe("código 40P01");
  });

  it("describe los SQLSTATE que ya no son permanentes (para el log del reintento)", () => {
    expect(describeFailure(withCode("57P03"))).toBe("código 57P03");
    expect(describeFailure(withCode("42501"))).toBe("código 42501");
  });

  it("sin código dice que no lo hay, sin citar el mensaje", () => {
    expect(describeFailure(new Error("lat=6.2518"))).toBe("error sin código");
    expect(describeFailure("texto")).toBe("error sin código");
  });
});
