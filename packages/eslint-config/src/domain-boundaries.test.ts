import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { domainBoundaries } from "./domain-boundaries.js";

const DOMAIN_FILE = "services/processor/src/domain/stop-detection.ts";

async function lint(code: string, filePath: string) {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } }, domainBoundaries],
  });
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages ?? [];
}

describe("regla de pureza de domain/ (regla 1 de CLAUDE.md)", () => {
  it.each([
    ['import { Pool } from "pg";', "pg"],
    ['import type { Pool } from "pg";', "pg (solo tipos)"],
    ['import { Kafka } from "kafkajs";', "kafkajs"],
    ['import Fastify from "fastify";', "fastify"],
    ['import cors from "@fastify/cors";', "@fastify/*"],
    ['import { tool } from "@langchain/core/tools";', "@langchain/*"],
    ['import CircuitBreaker from "opossum";', "opossum"],
    ['import { createPool } from "@fleet/platform";', "@fleet/platform"],
    ['import { readFile } from "node:fs/promises";', "node:fs/promises"],
    ['import { createServer } from "node:http";', "node:http"],
    ['import { randomUUID } from "node:crypto";', "node:crypto"],
    ['import { readFileSync } from "fs";', "fs sin prefijo"],
    ['import { connect } from "net";', "net sin prefijo"],
    ['import { PgRepo } from "../infrastructure/pg-repo.js";', "infrastructure/ relativo"],
    ['import { route } from "../../interfaces/http/route.js";', "interfaces/ relativo"],
    ['import { ingest } from "../application/ingest.js";', "application/ relativo"],
    ['import { env } from "../config/env.js";', "carpeta hermana de domain/"],
    ['import { env } from "../../config/env.js";', "fuera de src/"],
    ['import { schema } from "../../../../packages/contracts/src/index.js";', "otro paquete por ruta relativa"],
    ['import { x } from "./../application/x.js";', "ruta con ./.. que sale de domain/"],
    ['import { x } from "./a/../../x.js";', "ruta normalizada que sale de domain/"],
    ['import { x } from "..";', "el padre de domain/"],
    ['import { x } from "../vehicle/vehicle.js";', "../ desde domain/x.ts sale de domain/"],
    ['export * from "../config/env.js";', "re-export fuera de domain/"],
    ['export { env } from "../config/env.js";', "re-export con nombre fuera de domain/"],
    ['import type { Env } from "../config/env.js";', "solo tipos fuera de domain/"],
    ["const t = new Date();", "new Date() sin argumentos"],
    ["const t = Date.now();", "Date.now()"],
    ["const now = Date.now;", "referencia a Date.now"],
    ["const t = Date();", "Date() sin new"],
    ["const r = Math.random();", "Math.random()"],
    ["const r = Math['random']();", "Math['random']"],
    ["const t = performance.now();", "performance"],
    ["const g = global.process;", "global"],
    ['export * from "kafkajs";', "re-export de kafkajs"],
    ['const { Pool } = await import("pg");', "import dinámico de pg"],
    ['type P = import("pg").Pool;', "tipo import(...)"],
    ['const pg = require("pg");', "require"],
    ['import pino from "pino";', "pino (no está en la lista blanca)"],
    ['import axios from "axios";', "cualquier paquete fuera de la lista blanca"],
    ['import { Redis } from "ioredis";', "ioredis"],
    ['import { request } from "undici";', "undici"],
    ['import type { Logger } from "pino";', "pino (solo tipos)"],
    ['import { zod } from "zod-fake";', "paquete con prefijo de uno permitido"],
    ['import { x } from "@fleet/contracts-extra";', "paquete con prefijo de @fleet/contracts"],
    ['import { it } from "vitest-evil";', "paquete con prefijo de vitest"],
    ['import pg = require("pg");', "import = require"],
    ['export { Pool } from "pg";', "re-export con nombre de pg"],
    ['const r = await fetch("https://example.com");', "global fetch"],
    ["const url = process.env.DATABASE_URL;", "process.env"],
    ['console.log("hola");', "console"],
    ["const id = crypto.randomUUID();", "global crypto"],
    ["setTimeout(() => undefined, 10);", "setTimeout"],
    ["setInterval(() => undefined, 10);", "setInterval"],
    ["const b = Buffer.from('x');", "Buffer"],
    ["const ws = new WebSocket('ws://x');", "WebSocket"],
    ["const es = new EventSource('http://x');", "EventSource"],
    ["const x = new XMLHttpRequest();", "XMLHttpRequest"],
    ["const f = globalThis.fetch;", "globalThis"],
  ])("rechaza %s (%s)", async (code) => {
    const messages = await lint(code, DOMAIN_FILE);

    const violation = messages.find((m) =>
      ["no-restricted-imports", "no-restricted-syntax", "no-restricted-globals", "fleet/domain-relative-imports"].includes(
        m.ruleId ?? "",
      ),
    );
    expect(violation?.severity).toBe(2);
  });

  it("explica la causa según el tipo de violación", async () => {
    const infra = await lint('import { Pool } from "pg";', DOMAIN_FILE);
    const unknown = await lint('import pino from "pino";', DOMAIN_FILE);
    const global = await lint("const r = fetch('x');", DOMAIN_FILE);

    expect(infra.map((m) => m.message)).toEqual(expect.arrayContaining([expect.stringMatching(/base de datos/)]));
    expect(unknown.map((m) => m.message)).toEqual([expect.stringMatching(/solo importa rutas relativas de domain\/, zod/)]);
    expect(global.map((m) => m.message)).toEqual([expect.stringMatching(/global fetch/)]);
  });

  it.each([
    ['import { z } from "zod";', "zod"],
    ['import type { TelemetryPoint } from "@fleet/contracts";', "@fleet/contracts"],
    ['import { haversine } from "./geo.js";', "módulo hermano del dominio"],
    ['import { Vehicle } from "./vehicle/vehicle.js";', "otro módulo del dominio (subcarpeta)"],
    ['import { a } from "./a/../b.js";', "ruta con .. que se queda dentro de domain/"],
    ['import type { Vehicle } from "./vehicle/vehicle.js";', "import type dentro de domain/"],
    ['export { Vehicle } from "./vehicle/vehicle.js";', "re-export dentro de domain/"],
    ["const at = new Date('2026-01-01T00:00:00Z');", "new Date(valor)"],
    ["const copy = (d: Date) => new Date(d.getTime());", "new Date(valor) y Date como tipo"],
    ["const t = Date.parse('2026-01-01');", "Date.parse (determinista)"],
    ["const m = Math.max(1, 2) + Math.floor(2.5);", "Math determinista"],
    ["const performance = (x: number) => x; performance(1);", "identificador local llamado performance"],
    ['import assert from "node:assert/strict";', "node:assert"],
    ['import { inspect } from "node:util";', "node:util"],
    ['import { describe, expect, it } from "vitest";', "vitest"],
    ['import { vehicle } from "./vehicle";', "ruta relativa sin extensión"],
    ["const stamp = (now: Date) => now.toISOString();", "sin globales con I/O"],
    ["const process = (x: number) => x + 1; process(2);", "un identificador local que se llama igual que un global"],
  ])("permite %s (%s)", async (code) => {
    const messages = await lint(code, DOMAIN_FILE);

    expect(messages).toEqual([]);
  });

  it("resuelve las rutas contra el archivo: desde un subdirectorio de domain/ se puede subir hasta domain/ pero no más", async () => {
    const nested = "services/processor/src/domain/vehicle/vehicle.ts";

    expect(await lint('import { haversine } from "../geo.js";', nested)).toEqual([]);
    expect(await lint('import { haversine } from "../../geo.js";', nested)).toMatchObject([{ ruleId: "fleet/domain-relative-imports" }]);
    expect(await lint('import { env } from "../../config/env.js";', nested)).toMatchObject([{ ruleId: "fleet/domain-relative-imports" }]);
  });

  it("explica que la ruta sale de domain/ y que el tiempo entra por puertos", async () => {
    const outside = await lint('import { env } from "../config/env.js";', DOMAIN_FILE);
    const clock = await lint("const t = Date.now();", DOMAIN_FILE);

    expect(outside.map((m) => m.message)).toEqual([expect.stringMatching(/sale de domain\//)]);
    expect(clock.map((m) => m.message)).toEqual([expect.stringMatching(/tiempo y la aleatoriedad entran por puertos.*Clock/)]);
  });

  it("no aplica fuera de domain/: la infraestructura sí puede importar pg", async () => {
    const messages = await lint('import { Pool } from "pg";', "services/processor/src/infrastructure/pg-repo.ts");

    expect(messages).toEqual([]);
  });

  it("no aplica fuera de domain/: la infraestructura sí puede leer el reloj y usar rutas relativas a otras capas", async () => {
    const file = "services/processor/src/infrastructure/clock.ts";

    expect(await lint("export const now = () => new Date();", file)).toEqual([]);
    expect(await lint('import { env } from "../config/env.js";', file)).toEqual([]);
  });
});
