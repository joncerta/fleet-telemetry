/**
 * Caché en memoria con tamaño acotado y vencimiento por entrada. Sin dependencias: lo que necesita la caché de
 * tokens cabe en un `Map` (que recuerda el orden de inserción).
 *
 * - Vencimiento: una entrada vive `ttlMs` desde que se guarda; al leerla vencida se descarta.
 * - Tamaño: al llegar a `maxEntries`, antes de guardar una clave nueva se descartan primero las vencidas y, si no basta,
 *   la más antigua (FIFO, no LRU: leer no la renueva, para que ningún dato viva más que su `ttlMs`).
 */
export class TtlCache<V> {
  readonly #entries = new Map<string, { value: V; expiresAt: number }>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: { ttlMs: number; maxEntries: number; now?: () => number }) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) throw new RangeError("maxEntries debe ser un entero >= 1");
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) throw new RangeError("ttlMs debe ser >= 0");
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? Date.now;
  }

  /** `{ value }` si hay una entrada vigente (el valor puede ser `null`), o `undefined` si no. */
  get(key: string): { value: V } | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    return { value: entry.value };
  }

  set(key: string, value: V): void {
    // Con ttl 0 nada llega a estar vigente: la caché queda desactivada sin ramas especiales.
    this.#entries.delete(key);
    if (this.#entries.size >= this.#maxEntries) this.#evict();
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * El `ttlMs` es el mismo para todas y `set` siempre reinserta la clave al final, así que el orden de inserción del `Map` es
   * el de vencimiento: se descartan las vencidas desde el principio y se corta en la primera vigente, sin recorrerlo entero.
   * Si el reloj retrocede, una vencida puede quedar tras una vigente: `get` comprueba siempre el vencimiento, así que solo
   * ocupa memoria un rato más.
   */
  #evict(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (now < entry.expiresAt) break;
      this.#entries.delete(key);
    }
    if (this.#entries.size < this.#maxEntries) return;
    const oldest = this.#entries.keys().next();
    if (!oldest.done) this.#entries.delete(oldest.value);
  }
}
