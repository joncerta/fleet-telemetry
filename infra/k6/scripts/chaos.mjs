// Escenarios de caos de la carga. Corre JUNTO a k6 (lo lanza run.mjs), nunca dentro de k6. SOLO LOCAL.
//
//   node infra/k6/scripts/chaos.mjs --action processor-restart|processor-outage --after 12 --run <runId>
//
// Escenario `processor-restart`
//   Acción:   `docker compose --profile app restart processor` (SIGTERM, apagado ordenado, arranque).
//   Momento:  `--after` segundos desde el inicio de la corrida (por defecto, a mitad de la carga estable).
//   Criterio: la verificación de conteos se cumple igual (sin pérdidas ni duplicados) y el lag del consumer vuelve a cero en
//             un tiempo acotado tras terminar la carga (lo comprueba verify.mjs).
// Escenario `processor-outage`: igual, pero con `stop`, 10 s de espera y `start` (acumula lag y lo drena).
// Solo usa `restart`, `stop` y `start` del processor (nunca `down`: el stack de infraestructura es compartido). Escribe infra/k6/.run/<runId>.chaos.json.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ensureRunDir, REPO_ROOT, RUN_DIR, sleep } from "./common.mjs";

const run = promisify(execFile);
// Cada acción es una lista de pasos: un comando de docker o una espera.
const COMPOSE = ["compose", "--profile", "app"];
const ACTIONS = {
  "processor-restart": [{ docker: [...COMPOSE, "restart", "processor"] }],
  // Variante más dura: el processor queda parado 10 s, así que se acumula lag y luego se drena.
  "processor-outage": [{ docker: [...COMPOSE, "stop", "processor"] }, { sleepSeconds: 10 }, { docker: [...COMPOSE, "start", "processor"] }],
};

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

const result = { runId, action, plannedAfterSeconds: afterSeconds, startedAt: null, finishedAt: null, durationSeconds: null, ok: false };
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
