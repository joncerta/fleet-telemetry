import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chatResponse } from "../../test-support/agent-fixtures";
import type { ChatState } from "./chat-controller";
import { ChatPanel } from "./ChatPanel";

const noop = () => undefined;
const render = (state: Partial<ChatState>) =>
  renderToStaticMarkup(
    <ChatPanel
      state={{ status: "idle", question: null, response: null, failure: null, breaker: null, ...state }}
      onAsk={noop}
      onRetry={noop}
      onCancel={noop}
    />,
  );

describe("ChatPanel", () => {
  it("la respuesta del agente (no confiable) se muestra como TEXTO: un HTML inyectado sale escapado", () => {
    const html = render({
      status: "answered",
      question: "<b>pregunta</b>",
      response: chatResponse({ answer: 'Placa <img src=x onerror="alert(1)"> y <script>alert(2)</script>' }),
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>pregunta</b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  it("muestra las toolCalls: nombre, estado y duración", () => {
    const html = render({
      status: "answered",
      response: chatResponse({
        toolCalls: [
          { name: "list_stopped_vehicles", input: { minMinutes: 20 }, status: "ok", durationMs: 180 },
          { name: "get_fleet_summary", input: {}, status: "error", durationMs: 2400 },
        ],
      }),
    });
    expect(html).toContain("list_stopped_vehicles");
    expect(html).toContain("correcta");
    expect(html).toContain("180 ms");
    expect(html).toContain("minMinutes: 20");
    expect(html).toContain("get_fleet_summary");
    expect(html).toContain("falló");
    expect(html).toContain("2,4 s");
  });

  it("con el breaker abierto avisa que los datos de la flota no están disponibles", () => {
    expect(render({ breaker: "open" })).toContain("Datos de la flota no disponibles");
    expect(render({ breaker: "closed" })).toContain("Datos de la flota disponibles.");
    expect(render({ breaker: null })).not.toContain("Datos de la flota");
  });

  it("estados: escribiendo (con cancelar), respuesta vacía y error con reintento", () => {
    expect(render({ status: "sending", question: "hola" })).toContain("El asistente está pensando…");
    expect(render({ status: "sending", question: "hola" })).toContain("Cancelar");
    expect(render({ status: "answered", response: chatResponse({ answer: "  " }) })).toContain("El asistente no devolvió una respuesta.");

    const failed = render({ status: "failed", failure: { message: "El asistente tardó demasiado en responder.", retryable: true, rateLimited: false } });
    expect(failed).toContain("El asistente tardó demasiado en responder.");
    expect(failed).toContain("Reintentar");
    const notRetryable = render({ status: "failed", failure: { message: "Tu sesión venció.", retryable: false, rateLimited: false } });
    expect(notRetryable).not.toContain("Reintentar");
  });
});
