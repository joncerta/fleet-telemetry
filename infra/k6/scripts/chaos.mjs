// Escenarios de caos de la carga. Corre JUNTO a k6 (lo lanza run.mjs), nunca dentro de k6. SOLO LOCAL.
//
//   node infra/k6/scripts/chaos.mjs --action processor-restart|processor-outage|processor-kill --after 12 --run <runId>
//
// Escenario `processor-restart`
//   Acción:   `docker compose --profile app restart processor` (SIGTERM, apagado ordenado, arranque).
//   Momento:  `--after` segundos desde el inicio de la corrida (por defecto, a mitad de la carga estable).
//   Criterio: la verificación de conteos se cumple igual (sin pérdidas ni duplicados), la DLQ NO repite mensajes (el apagado
//             ordenado termina el tramo y confirma el offset antes de salir) y el lag vuelve a cero en un tiempo acotado.
// Escenario `processor-outage`: igual, pero con `stop`, 10 s de espera y `start` (acumula lag y lo drena).
// Escenario `processor-kill`: `kill -s SIGKILL`, 5 s de espera y `start`. Es el que ejercita el fallo real de at-least-once: el proceso
//   muere SIN apagado ordenado, puede caer entre persistir un tramo y confirmar su offset, y el tramo se reentrega. Se lanza dentro de
//   la ráfaga offline (lotes grandes en vuelo; en humo la ráfaga va de los 10 s a los 18 s). Criterio: ninguna pérdida ni duplicado en
//   la base; en la DLQ se admiten repetidos (mismo eventId), pero cada eventId distinto debe estar.
// Solo usa `restart`, `stop`, `kill` y `start` del processor (nunca `down`: el stack de infraestructura es compartido).
// Respeta COMPOSE_PROJECT_NAME y COMPOSE_FILE si el stack local usa otro proyecto. Escribe infra/k6/.run/<runId>.chaos.json.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { INTERRUPTIONS } from "../lib/checks.js";
import { ensureRunDir, REPO_ROOT, RUN_DIR, sleep } from "./common.mjs";

const run = promisify(execFile);
// Cada acción es una lista de pasos: un comando de docker o una espera.
const COMPOSE = ["compose", "--profile", "app"];
const ACTIONS = {
  "processor-restart": [{ docker: [...COMPOSE, "restart", "processor"] }],
  // Variante más dura: el processor queda parado 10 s, así que se acumula lag y luego se drena.
  "processor-outage": [{ docker: [...COMPOSE, "stop", "processor"] }, { sleepSeconds: 10 }, { docker: [...COMPOSE, "start", "processor"] }],
  // Muerte abrupta: sin apagado ordenado. Si la política de reinicio ya lo levantó, `start` no hace nada.
  "processor-kill": [{ docker: [...COMPOSE, "kill", "-s", "SIGKILL", "processor"] }, { sleepSeconds: 5 }, { docker: [...COMPOSE, "start", "processor"] }],
};
for (const action of Object.keys(ACTIONS)) {
  if (!(action in INTERRUPTIONS)) throw new Error(`La acción ${action} no está en INTERRUPTIONS (lib/checks.js): la verificación no sabría si admite repetidos.`);
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const action = arg("--action", "processor-restart");
const afterSeconds = Number(arg("--after", "12"));
const runId = arg("--run", "adhoc");
if (!(action in ACTIONS) || !Number.isFinite(afterSeconds) || afterSeconds < 0) {
  process.stderr.write(`Uso: chaos.mjs --action ${Object.keys(ACTIONS).join("|")} --after <segundos> --run <runId>\n`);
  process.exit(2);
}

const result = { runId, action, hard: INTERRUPTIONS[action].hard, plannedAfterSeconds: afterSeconds, startedAt: null, finishedAt: null, durationSeconds: null, ok: false };
try {
  await sleep(afterSeconds * 1_000);
  result.startedAt = new Date().toISOString();
  const started = Date.now();
  for (const step of ACTIONS[action]) {
    if (step.docker) {
      process.stderr.write(`[caos] ${new Date().toISOString()} docker ${step.docker.join(" ")}\n`);
      await run("docker", step.docker, { cwd: REPO_ROOT, timeout: 120_000 });
    } else {
      await sleep(step.sleepSeconds * 1_000);
    }
  }
  result.finishedAt = new Date().toISOString();
  result.durationSeconds = (Date.now() - started) / 1_000;
  result.ok = true;
  process.stderr.write(`[caos] ${action} terminó en ${result.durationSeconds.toFixed(1)} s\n`);
} catch (error) {
  result.error = error instanceof Error ? error.message : "error desconocido";
  process.exitCode = 1;
} finally {
  ensureRunDir();
  writeFileSync(path.join(RUN_DIR, `${runId}.chaos.json`), JSON.stringify(result, null, 2));
}
