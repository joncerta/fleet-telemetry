import { describe, expect, it } from "vitest";
import { DEFAULT_SESSION_TIMEOUTS, resolveSessionTimeouts } from "./control.js";
import { MigrationError } from "./files.js";
import { IDLE_IN_TRANSACTION_TIMEOUT, LOCK_NOT_AVAILABLE, sqlState, timeoutHint } from "./sql-errors.js";

const timeouts = { lockTimeoutMs: 8_000, idleInTransactionTimeoutMs: 60_000 };
const pgError = (code: string, message = "detalle de pg") => Object.assign(new Error(message), { code });

describe("sqlState", () => {
  it("lee el código de un error de pg y devuelve undefined en cualquier otro caso", () => {
    expect(sqlState(pgError("42P01"))).toBe("42P01");
    expect(sqlState(new Error("x"))).toBeUndefined();
    expect(sqlState("texto")).toBeUndefined();
    expect(sqlState(null)).toBeUndefined();
    expect(sqlState({ code: 42 })).toBeUndefined();
  });
});

describe("timeoutHint", () => {
  it("ante lock_timeout pide reintentar en una ventana de menos carga y nombra el tope configurado", () => {
    const hint = timeoutHint(pgError(LOCK_NOT_AVAILABLE), timeouts);

    expect(hint).toMatch(/8000 ms/);
    expect(hint).toMatch(/Reintenta en una ventana de menos carga/);
  });

  it("ante inactividad en transacción también", () => {
    const hint = timeoutHint(pgError(IDLE_IN_TRANSACTION_TIMEOUT), timeouts);

    expect(hint).toMatch(/60000 ms/);
    expect(hint).toMatch(/ventana de menos carga/);
  });

  it("no inventa una pista para otros errores y no repite el mensaje de pg", () => {
    expect(timeoutHint(pgError("42601"), timeouts)).toBeUndefined();
    expect(timeoutHint(new Error("boom"), timeouts)).toBeUndefined();
    expect(timeoutHint(pgError(LOCK_NOT_AVAILABLE, "tabla secreta"), timeouts)).not.toContain("secreta");
  });
});

describe("resolveSessionTimeouts", () => {
  it("por defecto usa 8 s de lock_timeout (entre 5 y 10 s) y 60 s de inactividad", () => {
    expect(DEFAULT_SESSION_TIMEOUTS.lockTimeoutMs).toBeGreaterThanOrEqual(5_000);
    expect(DEFAULT_SESSION_TIMEOUTS.lockTimeoutMs).toBeLessThanOrEqual(10_000);
    expect(resolveSessionTimeouts()).toEqual({ lockTimeoutMs: 8_000, idleInTransactionTimeoutMs: 60_000 });
  });

  it("acepta cambios parciales", () => {
    expect(resolveSessionTimeouts({ lockTimeoutMs: 5_000 })).toEqual({ lockTimeoutMs: 5_000, idleInTransactionTimeoutMs: 60_000 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rechaza %s (entra al texto de options de la conexión)", (value) => {
    expect(() => resolveSessionTimeouts({ lockTimeoutMs: value })).toThrow(MigrationError);
    expect(() => resolveSessionTimeouts({ idleInTransactionTimeoutMs: value })).toThrow(MigrationError);
  });
});
