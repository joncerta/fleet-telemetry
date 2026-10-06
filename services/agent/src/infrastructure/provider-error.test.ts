import { describe, expect, it } from "vitest";
import { describeProviderError, statusOf } from "./provider-error.js";

/** La forma de un APIError del SDK de Anthropic: `status`, `type`, `requestID` y el cuerpo en `error`; el `name` queda "Error". */
class FakeApiError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly error?: unknown,
    readonly type?: string,
    readonly requestID?: string,
  ) {
    super("mensaje con la pregunta sensible y sk-ant-SECRETO");
  }
}
class BadRequestError extends FakeApiError {}

describe("describeProviderError", () => {
  it("un 400 invalid_request_error: clase del constructor, estado y error.type; no es configuración rota", () => {
    const body = { type: "error", error: { type: "invalid_request_error", message: "This API key is not scoped to a workspace" } };

    expect(describeProviderError(new BadRequestError(400, body, "invalid_request_error"))).toEqual({
      causeName: "BadRequestError",
      causeStatus: 400,
      causeErrorType: "invalid_request_error",
      providerMisconfigured: false,
    });
  });

  it("toma el error.type del cuerpo si el error no trae `type`", () => {
    const error = new FakeApiError(401, { type: "error", error: { type: "authentication_error", message: "x" } });

    expect(describeProviderError(error)).toMatchObject({ causeStatus: 401, causeErrorType: "authentication_error" });
  });

  it.each([401, 403, 404])("un %i marca providerMisconfigured", (status) => {
    expect(describeProviderError(new FakeApiError(status)).providerMisconfigured).toBe(true);
  });

  it.each([400, 408, 429, 500, 529])("un %i no marca providerMisconfigured", (status) => {
    expect(describeProviderError(new FakeApiError(status)).providerMisconfigured).toBe(false);
  });

  it("recorre la cadena de cause hasta el eslabón que trae el estado", () => {
    const inner = new FakeApiError(404, { error: { type: "not_found_error" } });
    const wrapped = new Error("envoltorio de LangChain", { cause: new Error("otro", { cause: inner }) });

    expect(describeProviderError(wrapped)).toMatchObject({ causeStatus: 404, causeErrorType: "not_found_error", providerMisconfigured: true });
  });

  it("sin estado HTTP (timeout, red) describe el error recibido sin estado ni tipo", () => {
    const timeout = Object.assign(new Error("tardó"), { name: "ModelDeadlineError" });

    expect(describeProviderError(timeout)).toEqual({ causeName: "ModelDeadlineError", providerMisconfigured: false });
  });

  it("no se cuelga con causas circulares", () => {
    const a = new Error("a");
    a.cause = new Error("b", { cause: a });

    expect(describeProviderError(a)).toEqual({ causeName: "Error", providerMisconfigured: false });
  });

  describe("allowlist de error.type", () => {
    it.each([
      "invalid_request_error",
      "authentication_error",
      "billing_error",
      "permission_error",
      "not_found_error",
      "request_too_large",
      "rate_limit_error",
      "timeout_error",
      "api_error",
      "overloaded_error",
    ])("acepta %s", (type) => {
      expect(describeProviderError(new FakeApiError(400, undefined, type)).causeErrorType).toBe(type);
    });

    it.each(["otro_error_valido", "Tu pregunta fue: dónde está ABC123", "error", ""])("omite %j (fuera de la lista)", (type) => {
      const info = describeProviderError(new FakeApiError(400, { error: { type } }, type));

      expect(info).not.toHaveProperty("causeErrorType");
    });
  });

  describe("causeName", () => {
    it("un name con texto libre cae a Error", () => {
      const error = Object.assign(new Error("x"), { name: "falló con la pregunta: ¿dónde está ABC123?" });

      expect(describeProviderError(error).causeName).toBe("Error");
    });

    it("un valor que no es Error cae a Error", () => {
      expect(describeProviderError("texto con la pregunta").causeName).toBe("Error");
    });

    it("un nombre válido pero demasiado largo cae a Error", () => {
      expect(describeProviderError(Object.assign(new Error("x"), { name: "A".repeat(65) })).causeName).toBe("Error");
    });
  });

  describe("providerRequestId", () => {
    it("se incluye si tiene la forma req_...", () => {
      expect(describeProviderError(new FakeApiError(400, undefined, undefined, "req_011CT")).providerRequestId).toBe("req_011CT");
    });

    it.each(["req_con espacios", "abc", "req_"])("se omite %j", (id) => {
      expect(describeProviderError(new FakeApiError(400, undefined, undefined, id))).not.toHaveProperty("providerRequestId");
    });
  });
});

describe("statusOf", () => {
  it("devuelve solo enteros HTTP válidos", () => {
    expect(statusOf({ status: 401 })).toBe(401);
    expect(statusOf({ status: "401" })).toBeUndefined();
    expect(statusOf({ status: 42 })).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
  });
});
