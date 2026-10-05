import { migrationLabel } from "./control.js";
import type { MigrationStatus } from "./runner.js";

/** Texto legible de `db:status`. Termina con una línea de resumen estable (`discrepancias: N`). */
export function formatMigrationStatus(status: MigrationStatus): string {
  const lines: string[] = [`Aplicadas (${status.applied.length}):`];
  for (const row of status.applied) {
    const note = row.downChecksumRegistered ? "" : "  [down sin registrar: corre pnpm db:migrate]";
    lines.push(`  ${migrationLabel(row.version, row.name)}  ${row.appliedAt.toISOString()}${note}`);
  }
  lines.push(`Pendientes (${status.pending.length}):`);
  for (const row of status.pending) {
    lines.push(`  ${migrationLabel(row.version, row.name)}`);
  }
  if (status.discrepancies.length > 0) {
    lines.push("Discrepancias:");
    for (const problem of status.discrepancies) lines.push(`  - ${problem}`);
  }
  lines.push(`discrepancias: ${status.discrepancies.length}`);
  return `${lines.join("\n")}\n`;
}
