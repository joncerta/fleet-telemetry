// Config de la web: la ÚNICA del monorepo (la de la raíz) más las reglas de React y de Next. ESLint 10 busca la config desde la carpeta
// de cada archivo, así que esta aplica a apps/web y la raíz sigue mandando en todo lo demás.
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import root from "../../eslint.config.js";

// React y Next solo donde hay código React. El e2e (e2e/**) es Node: su `use(...)` es el de los fixtures de Playwright, no el hook.
const reactFiles = ["src/**/*.{ts,tsx}"];

export default defineConfig(
  root,
  {
    // `public/vendor/**`: copias generadas del worker de MapLibre (scripts/copy-maplibre-worker.mjs), no código del proyecto.
    ignores: [".next/**", ".next-e2e/**", "next-env.d.ts", "design/**", "public/vendor/**", "playwright-report/**", "test-results/**", "e2e/.logs/**"],
  },
  { files: reactFiles, extends: [reactHooks.configs.flat.recommended] },
  { files: reactFiles, extends: [nextPlugin.configs["core-web-vitals"]] },
);
