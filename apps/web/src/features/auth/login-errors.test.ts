import { describe, expect, it } from "vitest";
import { ApiRequestError, NetworkError, UnauthorizedError } from "../../lib/api/http-client";
import { pairingErrorMessage } from "../pairing/pairing-errors";
import { loginErrorMessage } from "./login-errors";

describe("loginErrorMessage", () => {
  it("un 401 es genérico: no dice si el correo existe", () => {
    expect(loginErrorMessage(new UnauthorizedError())).toBe("Correo o contraseña incorrectos.");
  });

  it("un 429 dice cuánto esperar, en minutos redondeados hacia arriba", () => {
    expect(loginErrorMessage(new ApiRequestError(429, "rate_limited", "x", 61))).toBe("Demasiados intentos. Inténtalo de nuevo en 2 min.");
    expect(loginErrorMessage(new ApiRequestError(429, "rate_limited", "x", null))).toBe("Demasiados intentos. Espera unos minutos e inténtalo de nuevo.");
  });

  it("sin conexión y errores inesperados", () => {
    expect(loginErrorMessage(new NetworkError())).toMatch(/No se pudo conectar/);
    expect(loginErrorMessage(new Error("boom"))).toBe("No se pudo iniciar sesión. Inténtalo de nuevo.");
  });
});

describe("pairingErrorMessage", () => {
  it("un 404 cubre tanto un vehículo inexistente como uno de otro tenant", () => {
    expect(pairingErrorMessage(new ApiRequestError(404, "not_found", "x", null))).toBe("Ese vehículo no existe o no pertenece a tu flota.");
    expect(pairingErrorMessage(new NetworkError())).toMatch(/No se pudo conectar/);
  });
});
