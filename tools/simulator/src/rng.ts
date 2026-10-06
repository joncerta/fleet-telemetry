/** Generador pseudoaleatorio con semilla (mulberry32): la misma semilla da la misma secuencia, para rutas reproducibles. */
export interface Rng {
  /** Número en [0, 1). */
  next(): number;
  /** Número en [min, max). */
  range(min: number, max: number): number;
  /** Verdadero con probabilidad `p` (0-1). */
  chance(p: number): boolean;
  /** Normal con media 0 y desviación `sd` (Box-Muller). */
  normal(sd: number): number;
  /** Un RNG hijo, independiente del padre, derivado de este y de una etiqueta (un RNG por vehículo). */
  fork(label: string): Rng;
}

function hashLabel(label: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < label.length; index += 1) {
    hash = Math.imul(hash ^ label.charCodeAt(index), 16_777_619);
  }
  return hash >>> 0;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    normal: (sd) => {
      // 1 - next() está en (0, 1]: evita log(0).
      const u = 1 - next();
      const v = next();
      return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    // La semilla del hijo depende de la del padre (su estado inicial) y de la etiqueta, no del consumo del padre.
    fork: (label) => createRng((seed ^ hashLabel(label)) >>> 0),
  };
}
