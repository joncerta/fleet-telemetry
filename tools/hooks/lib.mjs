// Funciones puras del hook verify-affected, separadas para poder testearlas (lib.test.mjs).

/** Carpetas del workspace cuyos subdirectorios con package.json son paquetes verificables. */
export const WORKSPACE_DIRS = ["apps", "services", "packages", "tools", "tests"];

/**
 * Raíz del árbol que hay que verificar. Va primero la raíz git del `cwd` del agente: un subagente
 * aislado en un worktree trabaja en otro árbol que CLAUDE_PROJECT_DIR (la raíz del proyecto
 * principal). Sin `cwd` o fuera de git, cae en CLAUDE_PROJECT_DIR y luego en el cwd del proceso
 * (nunca en un `cwd` que git no reconoció: podría ser una ruta inválida y el hook saldría sin verificar).
 *
 * @param {{ cwd?: string, projectDir?: string, processCwd: string }} where
 * @param {(dir: string) => string | undefined} gitTopLevel raíz git de `dir`, o undefined si no es un repo
 */
export function resolveRoot(where, gitTopLevel) {
  for (const dir of [where.cwd, where.projectDir]) {
    if (!dir) continue;
    const top = gitTopLevel(dir);
    if (top) return top;
  }
  return where.projectDir || where.processCwd;
}

/**
 * Directorios de paquete (`<carpeta>/<paquete>`) tocados por los archivos cambiados.
 * Las rutas vienen de `git status` y siempre usan "/".
 *
 * @param {readonly string[]} files
 * @param {readonly string[]} [workspaceDirs]
 */
export function affectedPackageDirs(files, workspaceDirs = WORKSPACE_DIRS) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split("/");
    // Solo archivos dentro de un paquete (<carpeta>/<paquete>/...), no sueltos en la carpeta.
    if (parts.length >= 3 && workspaceDirs.includes(parts[0])) dirs.add(`${parts[0]}/${parts[1]}`);
  }
  return [...dirs];
}

/** Quita las secuencias de color ANSI: el stderr del hook lo lee un agente, no una terminal. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}
