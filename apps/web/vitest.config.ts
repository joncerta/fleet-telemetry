import { defineConfig } from "vitest/config";

// Unitarios de la lógica pura, el store, el cliente SSE (EventSource falso) y la API (fetch falso): sin red, sin navegador.
// Los e2e de Playwright viven en e2e/ y no los corre vitest.
export default defineConfig({
  test: {
    // `.test.tsx`: componentes de presentación renderizados con `react-dom/server` (sin navegador).
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", ".next/**", ".next-e2e/**", "e2e/**"],
    environment: "node",
  },
});
