// PRNG determinista sin dependencias (corre en k6 y en Node). Todo el flujo de datos de la carga sale de funciones
// PURAS de (semilla, espacio, vehículo, lote, posición): el mismo evento se puede regenerar idéntico (duplicados reales)
// sin estado compartido entre VUs.

/** xmur3: mezcla una lista de enteros/strings en un entero sin signo de 32 bits. */
export function hash32(...parts) {
  let h = 1779033703 ^ parts.length;
  const text = parts.join("|");
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32: generador de 32 bits con semilla. Devuelve una función que da números en [0, 1). */
export function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (value, width) => (value >>> 0).toString(16).padStart(8, "0").slice(-width);

/**
 * UUID v4 válido (versión 4, variante RFC 4122) con los primeros 8 hex fijados a `runTag`. El prefijo identifica la
 * corrida: la verificación cuenta filas y mensajes de la DLQ por prefijo de `eventId`, sin depender de relojes.
 */
export function uuidWithTag(runTag, rng) {
  const g2 = hex(rng() * 4294967296, 4);
  const g3 = `4${hex(rng() * 4294967296, 3)}`;
  const g4 = `${"89ab"[Math.floor(rng() * 4)]}${hex(rng() * 4294967296, 3)}`;
  const g5 = `${hex(rng() * 4294967296, 8)}${hex(rng() * 4294967296, 4)}`;
  return `${hex(runTag, 8)}-${g2}-${g3}-${g4}-${g5}`;
}
