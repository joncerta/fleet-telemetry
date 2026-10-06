import { defineConfig } from "vitest/config";

// Unitarios del núcleo y la lógica pura: sin red, sin dispositivo, sin expo-sqlite ni react-native.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
