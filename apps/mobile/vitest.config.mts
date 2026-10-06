import { defineConfig } from "vitest/config";

// Unitarios del núcleo y la lógica pura: sin red, sin dispositivo, sin expo-sqlite ni react-native.
// `config/` incluye las pruebas de la configuración de build (eas.json), que no tocan el código de la app.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "config/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
