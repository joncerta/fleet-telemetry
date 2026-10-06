#!/usr/bin/env node
// Hook de Claude Code para Stop y SubagentStop (ver CLAUDE.md, "Antes de terminar cualquier tarea").
//
// Corre typecheck y tests unitarios de los paquetes del monorepo con cambios sin commitear y de los
// que dependen de ellos. Si fallan, sale con código 2: Claude Code bloquea el cierre del turno o del
// subagente y le entrega el stderr a Claude para que corrija la causa real.
//
// - Sin package.json en la raíz (monorepo aún sin crear) o sin cambios en paquetes: no hace nada.
// - Si el código no cambió desde la última corrida en verde, no vuelve a correr.
// - Tras 3 bloqueos seguidos deja cerrar, igual que la regla de los agentes ("3 intentos y se
//   reporta"); en el tercero le pide a Claude que su resumen diga "tarea NO terminada".
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WORKSPACE_DIRS, affectedPackageDirs, resolveRoot, stripAnsi } from "./lib.mjs";

const MAX_CONSECUTIVE_BLOCKS = 3;
const CHECK_TIMEOUT_MS = 9 * 60 * 1000; // por debajo del timeout del hook en settings.json (600 s)
const ROOT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "turbo.json"];
// Subagentes que no editan código: no hace falta verificar al terminar.
const READ_ONLY_AGENTS = new Set(["architect-reviewer", "frontend-reviewer", "qa-verifier", "Explore", "Plan", "claude-code-guide"]);

const input = readStdinJson();
const root = resolveRoot({ cwd: input.cwd, projectDir: process.env.CLAUDE_PROJECT_DIR, processCwd: process.cwd() }, gitTopLevel);

if (READ_ONLY_AGENTS.has(input.agent_type)) process.exit(0);
if (!existsSync(join(root, "package.json"))) process.exit(0);

const changed = changedFiles(root);
const rootConfigChanged = changed.some((f) => ROOT_FILES.includes(f));
const packages = rootConfigChanged ? allPackages(root) : affectedPackages(root, changed);
if (packages.length === 0) process.exit(0);

const stateFile = statePath(input);
const state = readState(stateFile);
const fingerprint = fingerprintOf(root, packages, changed);
if (state.lastGreen === fingerprint) process.exit(0);

const run = runChecks(root, packages);
if (run.ok) {
  writeState(stateFile, { lastGreen: fingerprint, blocks: 0 });
  process.exit(0);
}

const blocks = (state.blocks ?? 0) + 1;
if (blocks > MAX_CONSECUTIVE_BLOCKS) {
  writeState(stateFile, { ...state, blocks: 0 });
  process.exit(0);
}
writeState(stateFile, { ...state, blocks });

const lastAttempt =
  blocks === MAX_CONSECUTIVE_BLOCKS
    ? `\nEs el bloqueo ${blocks} de ${MAX_CONSECUTIVE_BLOCKS}. Si no puedes corregir la causa real, el próximo cierre se permitirá, pero tu resumen debe decir "tarea NO terminada" e incluir este fallo.`
    : "";
process.stderr.write(
  `Verificación automática fallida en: ${packages.map((p) => p.name).join(", ")}.\n` +
    `Comando: ${run.command}\n` +
    `Corrige la causa real. No saltes tests, no debilites aserciones ni silencies tipos (regla 17 de CLAUDE.md).${lastAttempt}\n\n` +
    tail(stripAnsi(run.output), 80) +
    "\n",
);
process.exit(2);

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

/** Archivos modificados, en stage o sin trackear respecto de HEAD, con rutas relativas a la raíz. */
function changedFiles(cwd) {
  let out;
  try {
    out = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  } catch {
    return [];
  }
  const tokens = out.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i].slice(0, 2);
    files.push(tokens[i].slice(3));
    // En renombres y copias, el siguiente token es la ruta original.
    if (code.includes("R") || code.includes("C")) files.push(tokens[++i]);
  }
  return files;
}

function readPackage(cwd, dir) {
  const file = join(cwd, dir, "package.json");
  if (!existsSync(file)) return null;
  try {
    const { name } = JSON.parse(readFileSync(file, "utf8"));
    return typeof name === "string" && name ? { name, dir } : null;
  } catch {
    return null;
  }
}

function affectedPackages(cwd, files) {
  return affectedPackageDirs(files).map((d) => readPackage(cwd, d)).filter(Boolean);
}

/** Raíz git de `dir`, o undefined si no es un repo (o git no está disponible). */
function gitTopLevel(dir) {
  try {
    return git(dir, ["rev-parse", "--show-toplevel"]).trim() || undefined;
  } catch {
    return undefined;
  }
}

function allPackages(cwd) {
  const found = [];
  for (const top of WORKSPACE_DIRS) {
    if (!existsSync(join(cwd, top))) continue;
    for (const entry of readdirSync(join(cwd, top), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = readPackage(cwd, `${top}/${entry.name}`);
      if (pkg) found.push(pkg);
    }
  }
  return found;
}

/** Huella del código que se va a verificar: si no cambia, el resultado en verde sigue valiendo. */
function fingerprintOf(cwd, pkgs, files) {
  const dirs = pkgs.map((p) => p.dir);
  const relevant = files.filter((f) => ROOT_FILES.includes(f) || dirs.some((d) => f.startsWith(`${d}/`)));
  const hash = createHash("sha256");
  try {
    hash.update(git(cwd, ["diff", "HEAD", "--", ...dirs, ...ROOT_FILES]));
  } catch {
    return randomUUID(); // sin huella fiable: siempre se verifica
  }
  for (const f of relevant.sort()) {
    try {
      const s = statSync(join(cwd, f));
      hash.update(`${f}:${s.size}:${s.mtimeMs}\n`);
    } catch {
      hash.update(`${f}:borrado\n`);
    }
  }
  return hash.digest("hex");
}

function runChecks(cwd, pkgs) {
  if (!existsSync(join(cwd, "node_modules"))) {
    return {
      ok: false,
      command: "(ninguno)",
      output: "No se puede verificar: faltan las dependencias del monorepo. Pide al humano que corra `pnpm install` (requiere su aprobación).",
    };
  }
  const turboBin = join(cwd, "node_modules", ".bin", process.platform === "win32" ? "turbo.cmd" : "turbo");
  const steps = existsSync(turboBin)
    ? [["turbo", "run", "typecheck", "test", ...pkgs.map((p) => `--filter=...${p.name}`)]]
    : ["typecheck", "test"].map((task) => [...pkgs.flatMap((p) => ["--filter", `...${p.name}`]), "run", "--if-present", task]);

  let output = "";
  for (const args of steps) {
    const command = `pnpm ${args.join(" ")}`;
    const res = spawnSync("pnpm", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32", // pnpm es un .cmd en Windows
      timeout: CHECK_TIMEOUT_MS,
    });
    output += `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.error) return { ok: false, command, output: `${output}\n${res.error.message}` };
    if (res.status !== 0) return { ok: false, command, output };
  }
  return { ok: true, command: "", output };
}

function tail(text, lines) {
  return text.split(/\r?\n/).slice(-lines).join("\n");
}

function statePath(hookInput) {
  const safe = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, "_");
  const dir = join(tmpdir(), "fleet-telemetry-hooks");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${safe(hookInput.session_id ?? "sin-sesion")}-${safe(hookInput.agent_id ?? "main")}.json`);
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeState(file, value) {
  try {
    writeFileSync(file, JSON.stringify(value));
  } catch {
    // Sin estado solo se pierde la caché y el contador; la verificación sigue funcionando.
  }
}
