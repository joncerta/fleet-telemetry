import type { Config } from "tailwindcss";
import { tailwindTheme } from "./src/design/tokens";

// Tailwind 4 lo carga con `@config` desde `src/app/globals.css`. Los tokens viven en un solo módulo que también usa el mapa.
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: { extend: tailwindTheme },
} satisfies Config;
