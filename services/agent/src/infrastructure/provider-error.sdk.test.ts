import { describe, expect, it } from "vitest";
import { describeProviderError } from "./provider-error.js";
import { createProviderModel } from "./chat-model.js";

/** Errores REALES: el `ChatAnthropic` de producción contra un `fetch` que responde como Anthropic (cuerpo `{ type: "error", error: {...} }`). */
async function realFailure(status: number, type: string): Promise<unknown> {
  const model = createProviderModel({
    provider: "anthropic",
    model: "claude-test",
    apiKey: "sk-ant-SECRETO",
    callTimeoutMs: 5_000,
    maxConcurrency: 1,
    breaker: { errorThresholdPercentage: 50, volumeThreshold: 5, resetTimeoutMs: 1_000, rollingWindowMs: 10_000 },
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({ type: "error", error: { type, message: "mensaje con la pregunta sensible" } }), {
          status,
          headers: { "content-type": "application/json", "request-id": "req_1" },
        }),
      ),
  });
  return model.invoke("pregunta sensible").then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe("describeProviderError con errores reales de ChatAnthropic", () => {
  it.each([
    [400, "invalid_request_error", "BadRequestError", false],
    [401, "authentication_error", "AuthenticationError", true],
    [403, "permission_error", "PermissionDeniedError", true],
    [404, "not_found_error", "NotFoundError", true],
    [422, "invalid_request_error", "UnprocessableEntityError", false],
  ])("un %i del proveedor se describe con clase, estado y error.type", async (status, type, className, misconfigured) => {
    const error = await realFailure(status, type);

    const info = describeProviderError(error);

    expect(info).toEqual({ causeName: className, causeStatus: status, causeErrorType: type, providerRequestId: "req_1", providerMisconfigured: misconfigured });
    expect(JSON.stringify(info)).not.toMatch(/SECRETO|sensible/);
  });
});
