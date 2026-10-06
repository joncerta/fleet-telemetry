import { randomUUID } from "node:crypto";
import type { ChatResponse } from "@fleet/contracts";
import { createLogger, createSessionCodec } from "@fleet/platform";
import { vi } from "vitest";
import type { Chat } from "../application/chat.js";
import { createCheckHealth } from "../application/check-health.js";
import type { BreakerStatus } from "../application/ports.js";
import type { AgentIdentity } from "../domain/identity.js";
import { SESSION_COOKIE_NAME } from "../domain/protocol.js";
import { buildApp, type AgentApp, type AppDependencies } from "../interfaces/http/build-app.js";
import { registerChatRoute } from "../interfaces/http/chat-route.js";
import { createSessionAuth } from "../interfaces/http/session-auth.js";

/** Soporte de los tests de la capa HTTP: la app real de `buildApp` con las rutas reales y un caso de uso falso. No forma parte del build. */

export const TEST_SECRET = "t".repeat(32);
export const ALLOWED_ORIGIN = "http://localhost:3000";

export const NORTE: AgentIdentity = { userId: randomUUID(), tenantId: randomUUID() };
export const SUR: AgentIdentity = { userId: randomUUID(), tenantId: randomUUID() };

export const CHAT_RESPONSE: ChatResponse = {
  answer: "Hay 1 vehículo detenido.",
  toolCalls: [{ name: "get_stopped_vehicles", input: { minMinutes: 20, zoneKind: "critical", limit: 20 }, status: "ok", durationMs: 12 }],
  breaker: { state: "closed" },
};

export interface TestAppOptions {
  chat?: Chat;
  breaker?: BreakerStatus;
  userRateLimit?: { max: number; timeWindowMs: number };
  app?: Partial<AppDependencies>;
  /** Reloj de la cookie (ms). */
  now?: () => number;
}

/** Arma la app con las rutas reales, un logger que guarda cada línea y el caso de uso del chat falso (`options.chat` lo reemplaza). */
export async function makeTestApp(options: TestAppOptions = {}) {
  const lines: string[] = [];
  const logger = createLogger({ service: "agent-test", level: "info", destination: { write: (line: string) => void lines.push(line) } });
  const codec = createSessionCodec(TEST_SECRET);
  const now = options.now ?? Date.now;
  const auth = createSessionAuth({ codec, now });
  const breaker = options.breaker ?? { state: () => "closed" as const };
  const chat = options.chat ?? vi.fn<Chat>(() => Promise.resolve(CHAT_RESPONSE));

  const app: AgentApp = await buildApp({
    logger,
    trustProxyHops: 1,
    bodyLimitBytes: 16_384,
    rateLimit: { max: 1_000, timeWindowMs: 60_000 },
    corsOrigins: [ALLOWED_ORIGIN],
    checkHealth: createCheckHealth({ fleetApi: breaker }),
    registerRoutes: (instance) => {
      registerChatRoute(instance, { auth, chat, userRateLimit: options.userRateLimit ?? { max: 100, timeWindowMs: 60_000 } });
    },
    ...options.app,
  });

  /** Header `cookie` de una sesión válida de esa identidad. */
  const sessionCookieOf = (identity: AgentIdentity, expSeconds = Math.floor(now() / 1_000) + 3_600): string =>
    `${SESSION_COOKIE_NAME}=${codec.sign({ ...identity, exp: expSeconds })}`;

  return {
    app,
    chat,
    codec,
    sessionCookieOf,
    logged: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: () => lines.join(""),
  };
}
