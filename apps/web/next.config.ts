import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/** Raíz del monorepo: Turbopack y el trazado de archivos necesitan ver `packages/contracts`, que vive fuera de `apps/web`. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // El e2e compila con su propia URL de la API (las `NEXT_PUBLIC_*` se fijan al compilar): usa otra carpeta para no pisar el build normal.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ]);
  },
};

export default config;
