// Regla 1 de CLAUDE.md: `domain/` es puro, sin I/O ni imports de infraestructura.
// Archivo en JS (con JSDoc) para que el `eslint.config.js` de la raíz lo cargue sin compilar nada.
//
// Enfoque de lista blanca: lo que no está permitido explícitamente, está prohibido. Una lista negra de paquetes
// (pg, kafkajs...) deja pasar el siguiente que alguien instale (pino, axios, undici, ioredis...).
//
// Las rutas relativas las resuelve una regla propia (`fleet/domain-relative-imports`, sin dependencias): `domain/`
// solo puede importar archivos que estén dentro de `domain/`. Un plugin (`import-x/no-restricted-paths` o
// `eslint-plugin-boundaries`) exigiría declarar zonas por servicio y un resolver para resolver lo que aquí se
// decide con `path.resolve` y una comparación de prefijo.

import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Lo único que `domain/` puede importar, además de rutas relativas. Se expresa como una expresión regular
 * sobre el especificador del import (`no-restricted-imports` no tiene "permitir salvo"):
 * - rutas relativas (`./`, `../`);
 * - `zod` y `@fleet/contracts` (esquemas y tipos compartidos);
 * - `vitest` (los tests viven junto al dominio);
 * - `node:assert` y `node:util` (sin I/O ni estado global), con sus subrutas (`node:assert/strict`).
 */
const ALLOWED_IMPORT = String.raw`^(\.{1,2}(/|$)|zod$|@fleet/contracts$|vitest$|node:assert(/|$)|node:util$)`;
const NOT_ALLOWED_IMPORT = String.raw`^(?!${ALLOWED_IMPORT.slice(1)}).`;

/** Infraestructura conocida: solo mejora el mensaje; la lista blanca la rechazaría igual. */
const INFRASTRUCTURE_PACKAGES = [
  ["pg", "base de datos"],
  ["pg-*", "base de datos"],
  ["kafkajs", "Kafka"],
  ["fastify", "HTTP"],
  ["@fastify/*", "HTTP"],
  ["@langchain/*", "agente IA"],
  ["langchain", "agente IA"],
  ["opossum", "circuit breaker"],
  // Fábricas de Kafka, Postgres y logger: es infraestructura por definición.
  ["@fleet/platform", "infraestructura"],
];

const DYNAMIC_IMPORT_MESSAGE =
  "domain/ no usa import() dinámico, require() ni tipos import(\"...\"): un import estático permite verificar sus dependencias (regla 1 de CLAUDE.md).";

const ALLOWLIST_MESSAGE =
  "domain/ solo importa rutas relativas de domain/, zod, @fleet/contracts, vitest, node:assert y node:util (regla 1 de CLAUDE.md). " +
  "Todo lo demás es infraestructura: define un puerto en application/ y un adaptador en infrastructure/.";

/** Globales con I/O, reloj, entropía o estado compartido, y `globalThis`, que da acceso a todos ellos. */
const IMPURE_GLOBALS = [
  "fetch",
  "process",
  "console",
  "crypto",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "Buffer",
  "globalThis",
  // `global` es el `globalThis` de Node; `performance` da el reloj monotónico.
  "global",
  "performance",
];

const CLOCK_MESSAGE =
  "domain/ no lee el reloj ni genera aleatoriedad: el tiempo y la aleatoriedad entran por puertos (por ejemplo un Clock " +
  "definido en application/) o como argumentos. `Date` como tipo y `new Date(valor)` sí se permiten, pero no guardar `Date` o `Math` en una variable.";

/**
 * Reloj y entropía accedidos sin pasar por un global prohibido: `new Date()`, `Date()`, `Date.now` y `Math.random`,
 * y sus alias: guardar `Date` o `Math` en una variable (`const D = Date`, `const { now } = Date`,
 * `const { random } = Math`, `x = Date`) y construir con `Reflect.construct(Date, ...)`.
 * `Date` y `Math` solo se usan en el sitio de llamada: `new Date(valor)`, `Date.parse(...)`, `Math.max(...)`.
 */
const CLOCK_AND_ENTROPY_SELECTORS = [
  "NewExpression[callee.name='Date'][arguments.length=0]",
  "CallExpression[callee.name='Date']",
  "MemberExpression[object.name='Date'][property.name='now']",
  "MemberExpression[object.name='Date'][property.value='now']",
  "MemberExpression[object.name='Math'][property.name='random']",
  "MemberExpression[object.name='Math'][property.value='random']",
  "VariableDeclarator[init.type='Identifier'][init.name=/^(Date|Math)$/]",
  "AssignmentExpression[right.type='Identifier'][right.name=/^(Date|Math)$/]",
  "CallExpression[callee.object.name='Reflect'][callee.property.name='construct'][arguments.0.name='Date']",
];

const OUTSIDE_DOMAIN_MESSAGE =
  "domain/ solo importa archivos de domain/ (regla 1 de CLAUDE.md): esta ruta relativa sale de domain/ " +
  "(configuración, application/, infrastructure/, interfaces/, otro paquete...). Define un puerto en application/ y un adaptador en infrastructure/.";

/**
 * Carpeta `domain/` más cercana en la ruta del archivo, o `undefined` si no está dentro de una.
 * @param {string} filename
 * @returns {string | undefined}
 */
function domainRootOf(filename) {
  const matches = [...filename.matchAll(/[\\/]domain(?=[\\/])/g)];
  const last = matches.at(-1);
  return last === undefined ? undefined : filename.slice(0, last.index + last[0].length);
}

/** @param {string} specifier */
const isRelative = (specifier) => specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");

/** @type {import("eslint").Rule.RuleModule} */
const domainRelativeImports = {
  meta: {
    type: "problem",
    schema: [],
    messages: { outside: OUTSIDE_DOMAIN_MESSAGE },
    docs: { description: "domain/ solo importa rutas relativas que resuelven dentro de domain/" },
  },
  create(context) {
    const filename = context.filename;
    const root = domainRootOf(filename);
    const dir = dirname(filename);

    /** @param {{ value?: unknown, loc?: import("eslint").AST.SourceLocation | null }} source Literal del `from` del import o export. */
    function check(source) {
      const specifier = source.value;
      if (typeof specifier !== "string" || root === undefined || !isRelative(specifier) || !source.loc) return;
      const fromRoot = relative(root, resolve(dir, specifier));
      const outside = fromRoot === ".." || fromRoot.startsWith("..\\") || fromRoot.startsWith("../") || isAbsolute(fromRoot);
      if (outside) context.report({ loc: source.loc, messageId: "outside" });
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node.source);
      },
    };
  },
};

/** Plugin local con la regla de rutas relativas. Un único objeto compartido por toda config que lo registre. */
export const fleetPlugin = { rules: { "domain-relative-imports": domainRelativeImports } };

/** @type {import("eslint").Linter.Config} */
export const domainBoundaries = {
  name: "fleet/domain-boundaries",
  files: ["**/domain/**/*.{ts,mts,cts,tsx}"],
  plugins: { fleet: fleetPlugin },
  rules: {
    "fleet/domain-relative-imports": "error",
    // `no-restricted-imports` no ve lo que no es una declaración import: import(), require(), tipos
    // import("pg").Pool ni `import x = require("pg")`. En domain/ se prohíben del todo.
    "no-restricted-syntax": [
      "error",
      { selector: "ImportExpression", message: DYNAMIC_IMPORT_MESSAGE },
      { selector: "TSImportType", message: DYNAMIC_IMPORT_MESSAGE },
      { selector: "TSImportEqualsDeclaration", message: DYNAMIC_IMPORT_MESSAGE },
      { selector: "CallExpression[callee.name='require']", message: DYNAMIC_IMPORT_MESSAGE },
      ...CLOCK_AND_ENTROPY_SELECTORS.map((selector) => ({ selector, message: CLOCK_MESSAGE })),
    ],
    "no-restricted-globals": [
      "error",
      ...IMPURE_GLOBALS.map((name) => ({
        name,
        message: `domain/ no puede usar el global ${name} (I/O, reloj o entropía). Recibe el valor o un puerto desde application/.`,
      })),
    ],
    "no-restricted-imports": [
      "error",
      {
        // Incluye `import type`: un tipo de `pg` en el dominio ya acopla el dominio a la base de datos.
        // ESLint informa cada patrón que coincide: un paquete de infraestructura conocido recibe su mensaje
        // específico y además el de la lista blanca, que es la red de seguridad para todo lo demás.
        patterns: [
          ...INFRASTRUCTURE_PACKAGES.map(([name, what]) => ({
            group: [name, `${name}/**`],
            message: `domain/ no puede importar ${name} (${what}). Define un puerto en application/ y un adaptador en infrastructure/.`,
          })),
          // Las rutas relativas pasan esta lista blanca; `fleet/domain-relative-imports` exige que resuelvan dentro de domain/.
          { regex: NOT_ALLOWED_IMPORT, message: ALLOWLIST_MESSAGE },
        ],
      },
    ],
  },
};
