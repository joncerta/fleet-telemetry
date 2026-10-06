import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * "Anthropic falso" de los e2e del agente: un servidor HTTP local que habla lo justo del API de mensajes. El agente se levanta con
 * `AGENT_MODEL_PROVIDER=anthropic` y `ANTHROPIC_BASE_URL` apuntando aquí, así que el e2e recorre el `ChatAnthropic` real (`maxRetries`, el
 * guard con su breaker, las herramientas en el cuerpo) sin red ni API key. El test decide en cada momento si responde un mensaje válido o un 529.
 */

export type FakeAnthropicMode = "ok" | "overloaded";

export interface FakeAnthropicRequest {
  path: string;
  /** Cuerpo JSON de la petición (lo que `ChatAnthropic` envió: modelo, mensajes, herramientas). */
  body: unknown;
  /** Cabeceras de la petición (en minúsculas, como las entrega Node). */
  headers: IncomingMessage["headers"];
}

export interface FakeAnthropic {
  readonly url: string;
  mode: FakeAnthropicMode;
  /** Peticiones recibidas, en orden. */
  readonly requests: FakeAnthropicRequest[];
  close(): Promise<void>;
}

const MESSAGE = {
  id: "msg_fake_e2e",
  type: "message",
  role: "assistant",
  model: "claude-fake",
  content: [{ type: "text", text: "Respuesta del Anthropic falso." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 7 },
} as const;

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

export async function startFakeAnthropic(): Promise<FakeAnthropic> {
  const requests: FakeAnthropicRequest[] = [];
  const state = { mode: "ok" as FakeAnthropicMode };
  const server: Server = createServer((request, response) => {
    void readBody(request).then((body) => {
      requests.push({ path: request.url ?? "", body, headers: request.headers });
      if (state.mode === "overloaded") {
        response.writeHead(529, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(MESSAGE));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("El Anthropic falso no escucha en un puerto");

  return {
    url: `http://127.0.0.1:${address.port}`,
    get mode() {
      return state.mode;
    },
    set mode(mode: FakeAnthropicMode) {
      state.mode = mode;
    },
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
