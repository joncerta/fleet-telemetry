/**
 * Log de la app. Regla 14 (Ley 1581): NUNCA coordenadas, ni datos del conductor, ni el token. Por eso los campos solo
 * admiten números, booleanos y cadenas cortas, y el tipo no deja pasar objetos (un punto o una ubicación).
 */
type Field = number | boolean | string;

export function logEvent(event: string, fields: Record<string, Field> = {}): void {
  if (!__DEV__) return;
  const safe = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 64) : String(v)}`);
  console.log(`[fleet] ${event}${safe.length > 0 ? ` ${safe.join(" ")}` : ""}`);
}
