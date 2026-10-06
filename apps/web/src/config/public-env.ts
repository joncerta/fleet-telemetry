import { z } from "zod";

/** Una URL http(s) sin barra final, para concatenar rutas (`${url}/v1/...`). */
const httpUrl = z
  .url({ protocol: /^https?$/ })
  .transform((value) => value.replace(/\/+$/, ""));

/** Una variable vacía cuenta como ausente: así aplica el valor por defecto. */
const optional = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value.trim());

export const publicEnvSchema = z.object({
  fleetApiUrl: httpUrl.default("http://localhost:4002"),
  agentUrl: httpUrl.default("http://localhost:4003"),
  mapStyleUrl: httpUrl.default("https://tiles.openfreemap.org/styles/positron"),
});
export type PublicEnv = z.infer<typeof publicEnvSchema>;

export interface RawPublicEnv {
  NEXT_PUBLIC_FLEET_API_URL?: string;
  NEXT_PUBLIC_AGENT_URL?: string;
  NEXT_PUBLIC_MAP_STYLE_URL?: string;
}

const VARIABLE_NAMES = { fleetApiUrl: "NEXT_PUBLIC_FLEET_API_URL", agentUrl: "NEXT_PUBLIC_AGENT_URL", mapStyleUrl: "NEXT_PUBLIC_MAP_STYLE_URL" } as const;

/** Valida las variables públicas. Lanza con el nombre de la variable inválida (fail fast, regla 15). */
export function parsePublicEnv(raw: RawPublicEnv): PublicEnv {
  const result = publicEnvSchema.safeParse({
    fleetApiUrl: optional(raw.NEXT_PUBLIC_FLEET_API_URL),
    agentUrl: optional(raw.NEXT_PUBLIC_AGENT_URL),
    mapStyleUrl: optional(raw.NEXT_PUBLIC_MAP_STYLE_URL),
  });
  if (!result.success) {
    const invalid = result.error.issues.map((issue) => VARIABLE_NAMES[issue.path[0] as keyof typeof VARIABLE_NAMES] ?? String(issue.path[0]));
    throw new Error(`Configuración pública inválida: ${[...new Set(invalid)].join(", ")} debe ser una URL http(s).`);
  }
  return result.data;
}

// Next solo incrusta `process.env.NEXT_PUBLIC_*` escritas literalmente: no se puede iterar `process.env` en el navegador.
export const publicEnv: PublicEnv = parsePublicEnv({
  NEXT_PUBLIC_FLEET_API_URL: process.env.NEXT_PUBLIC_FLEET_API_URL,
  NEXT_PUBLIC_AGENT_URL: process.env.NEXT_PUBLIC_AGENT_URL,
  NEXT_PUBLIC_MAP_STYLE_URL: process.env.NEXT_PUBLIC_MAP_STYLE_URL,
});
