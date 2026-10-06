// MapLibre GL 6 carga su web worker desde un archivo aparte (`new URL("./maplibre-gl-worker.mjs", import.meta.url)`). Dentro del bundle
// de Next ese archivo no existe y el mapa nunca dibuja sus fuentes. Este script copia el worker y el módulo que importa
// (`maplibre-gl-shared.mjs`) de la MISMA versión instalada a `public/vendor/maplibre/`, y el mapa los registra con `setWorkerUrl`.
// Corre antes de `next dev` y `next build`; la carpeta destino es generada (está en .gitignore).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "vendor", "maplibre");

mkdirSync(target, { recursive: true });
for (const file of FILES) {
  const source = fileURLToPath(import.meta.resolve(`maplibre-gl/dist/${file}`));
  copyFileSync(source, join(target, file));
}
