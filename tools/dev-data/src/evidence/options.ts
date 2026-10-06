import { parseArgs } from "node:util";
import { z } from "zod";

export const DEFAULT_EVIDENCE_OUTPUT = "docs/evidence/persistence.md";

const positiveInt = (max: number) => z.coerce.number().int().min(1).max(max);

/** Tamaño por defecto: 300 vehículos x 14 días x 1 punto cada 30 s = 12 096 000 filas. */
const optionsSchema = z.object({
  vehicles: positiveInt(5000).default(300),
  days: positiveInt(60).default(14),
  interval: positiveInt(3600).default(30),
  seed: z.coerce.number().int().min(0).max(0xffffffff).default(20261006),
  zones: positiveInt(20_000).default(2000),
  out: z.string().min(1).default(DEFAULT_EVIDENCE_OUTPUT),
});

export interface EvidenceOptions {
  readonly vehicles: number;
  readonly days: number;
  readonly intervalSeconds: number;
  readonly seed: number;
  readonly zonesPerTenant: number;
  readonly out: string;
}

/** Lee `--vehicles --days --interval --seed --zones --out`. Un valor inválido lanza con el nombre de la opción. */
export function parseEvidenceOptions(argv: readonly string[]): EvidenceOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      vehicles: { type: "string" },
      days: { type: "string" },
      interval: { type: "string" },
      seed: { type: "string" },
      zones: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  const parsed = optionsSchema.safeParse(values);
  if (!parsed.success) {
    throw new Error(`Opciones inválidas de db:evidence: ${parsed.error.issues.map((i) => `--${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const o = parsed.data;
  return { vehicles: o.vehicles, days: o.days, intervalSeconds: o.interval, seed: o.seed, zonesPerTenant: o.zones, out: o.out };
}
