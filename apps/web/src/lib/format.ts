/**
 * Formato de fechas y números con locale `es-CO`, en la zona horaria del NAVEGADOR (la del usuario). Se usa solo en componentes de
 * cliente: formatear en el servidor daría otra zona y un error de hidratación. `timeZone` existe para los tests.
 */
const LOCALE = "es-CO";

const cache = new Map<string, Intl.DateTimeFormat>();
function dateFormat(options: Intl.DateTimeFormatOptions, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${JSON.stringify(options)}|${timeZone ?? ""}`;
  let format = cache.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(LOCALE, { ...options, ...(timeZone !== undefined && { timeZone }) });
    cache.set(key, format);
  }
  return format;
}

const toDate = (value: string | number): Date => new Date(value);

/** Hora con segundos (`14:05:09`). */
export function formatTime(value: string | number, timeZone?: string): string {
  return dateFormat({ hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }, timeZone).format(toDate(value));
}

/** Fecha corta y hora (`6/10/2026, 14:05`). */
export function formatDateTime(value: string | number, timeZone?: string): string {
  return dateFormat({ dateStyle: "short", timeStyle: "short", hourCycle: "h23" }, timeZone).format(toDate(value));
}

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

/** Entero con separador de miles de `es-CO` (`1.234`). */
export function formatInteger(value: number): string {
  return integer.format(value);
}

/** "hace menos de 1 min", "hace 1 min", "hace 12 min", "hace 2 h 5 min". */
export function formatAgo(minutes: number): string {
  if (minutes < 1) return "hace menos de 1 min";
  if (minutes < 60) return `hace ${formatInteger(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `hace ${formatInteger(hours)} h` : `hace ${formatInteger(hours)} h ${rest} min`;
}

/** Duración en minutos: "25 min", "1 h 5 min". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${formatInteger(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${formatInteger(hours)} h` : `${formatInteger(hours)} h ${rest} min`;
}
