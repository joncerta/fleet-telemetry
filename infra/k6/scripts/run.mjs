// Lanzador de una corrida de carga: k6 + caos opcional + verificación de conteos. SOLO LOCAL.
//
//   node --env-file-if-exists=.env infra/k6/scripts/run.mjs [--profile smoke|load] [--chaos processor-restart|processor-outage|processor-kill [--chaos-after 12]]
//                                                            [--vehicles 300] [--seed 42] [--run-id <id>]
//
// Pasos: (1) setup del tenant de carga si faltan los tokens, (2) comprueba /health del gateway, (3) k6, con el caos en paralelo si se
// pidió, (4) verificación de conteos tras lag cero. Sale con código distinto de cero si falla un threshold o una comprobación.
// El objetivo (BASE_URL) debe ser local; load.js lo vuelve a comprobar y aborta si no lo es.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRunDir, K6_DIR, RUN_DIR, TOKENS_FILE } from "./common.mjs";
import { printReport, verifyRun } from "./verify.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const profile = arg("--profile", "smoke");
const chaosAction = arg("--chaos", undefined);
// Momento por defecto: a mitad de la carga estable; `processor-kill` cae dentro de la ráfaga offline (humo: 10-18 s; load: 90-110 s).
const defaultChaosAfter = chaosAction === "processor-kill" ? (profile === "load" ? "95" : "12") : profile === "load" ? "60" : "12";
const chaosAfter = Number(arg("--chaos-after", defaultChaosAfter));
const seed = arg("--seed", "42");
const vehicles = arg("--vehicles", undefined);
const runId = arg("--run-id", `r${Date.now().toString(36)}`);
const baseUrl = process.env.BASE_URL || "http://localhost:4001";
const here = path.dirname(fileURLToPath(import.meta.url));

function exitCodeOf(child) {
  return new Promise((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`No se pudo lanzar el proceso: ${error.message}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

ensureRunDir();

if (!existsSync(TOKENS_FILE)) {
  process.stderr.write("No hay tokens de carga: ejecutando setup...\n");
  const code = await exitCodeOf(spawn(process.execPath, [path.join(here, "setup.mjs"), ...(vehicles ? ["--vehicles", vehicles] : [])], { stdio: "inherit" }));
  if (code !== 0) process.exit(code);
}

try {
  const health = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!health.ok) throw new Error(`/health respondió ${health.status}`);
} catch (error) {
  process.stderr.write(`El gateway no está listo en ${baseUrl}: ${error instanceof Error ? error.message : "error"}. Levanta el stack con \`docker compose --profile app up -d --wait\`.\n`);
  process.exit(1);
}

const t0Ms = Date.now();
const runFile = path.join(RUN_DIR, `${runId}.run.json`);
const runRecord = { runId, t0Ms, profile, seed: Number(seed), chaos: chaosAction ? { action: chaosAction, afterSeconds: chaosAfter } : null };
writeFileSync(runFile, JSON.stringify(runRecord, null, 2));

const slash = (value) => value.replaceAll("\\", "/");
const k6Args = [
  "run",
  "-e",
  `RUN_ID=${runId}`,
  "-e",
  `T0_MS=${t0Ms}`,
  "-e",
  `PROFILE=${profile}`,
  "-e",
  `SEED=${seed}`,
  "-e",
  `BASE_URL=${baseUrl}`,
  "-e",
  `TOKENS_FILE=${slash(TOKENS_FILE)}`,
  ...(vehicles ? ["-e", `VEHICLES=${vehicles}`] : []),
  ...["RATE", "DURATION", "BURST_RATE"].filter((name) => process.env[name]).flatMap((name) => ["-e", `${name}=${process.env[name]}`]),
  "load.js",
];

process.stderr.write(`Corrida ${runId} (${profile}${chaosAction ? `, caos ${chaosAction} a los ${chaosAfter} s` : ""}) contra ${baseUrl}\n`);
const k6 = spawn("k6", k6Args, { cwd: K6_DIR, stdio: "inherit" });
const chaos = chaosAction
  ? spawn(process.execPath, [path.join(here, "chaos.mjs"), "--action", chaosAction, "--after", String(chaosAfter), "--run", runId], { stdio: "inherit" })
  : null;
const [k6Code, chaosCode] = await Promise.all([exitCodeOf(k6), chaos ? exitCodeOf(chaos) : Promise.resolve(0)]);

let failed = k6Code !== 0 || chaosCode !== 0;
if (k6Code !== 0) process.stderr.write(`k6 terminó con código ${k6Code} (99 = thresholds fallidos).\n`);
if (chaosCode !== 0) process.stderr.write("La acción de caos falló: la corrida no demuestra nada.\n");

const summaryFile = path.join(RUN_DIR, `${runId}.k6.json`);
if (!existsSync(summaryFile)) {
  process.stderr.write("k6 no dejó su resumen: no hay nada que verificar.\n");
  process.exit(1);
}
try {
  const chaosRecord = chaosAction ? JSON.parse(readFileSync(path.join(RUN_DIR, `${runId}.chaos.json`), "utf8")) : undefined;
  const result = await verifyRun({ runId, t0Ms, k6: JSON.parse(readFileSync(summaryFile, "utf8")), chaos: chaosRecord });
  writeFileSync(path.join(RUN_DIR, `${runId}.verify.json`), JSON.stringify(result.report, null, 2));
  printReport(result);
  failed ||= !result.ok;
} catch (error) {
  process.stderr.write(`La verificación falló: ${error instanceof Error ? error.message : "error desconocido"}\n`);
  failed = true;
}
process.exitCode = failed ? 1 : 0;
