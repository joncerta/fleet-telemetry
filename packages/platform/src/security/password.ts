import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/** Parámetros de scrypt. Viajan dentro del hash, así que se pueden subir sin invalidar las contraseñas ya guardadas. */
export interface ScryptParams {
  /** Costo de CPU y memoria: potencia de 2. */
  readonly N: number;
  /** Tamaño de bloque. */
  readonly r: number;
  /** Paralelismo. */
  readonly p: number;
}

/**
 * Alternativa de OWASP para scrypt: N = 2^15, r = 8, p = 3 (unos 32 MiB por derivación y ~150 ms). Un login no es la ruta caliente:
 * se paga una derivación por intento.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 32_768, r: 8, p: 3 };

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const FORMAT = "scrypt";

/** Cotas de los parámetros que se aceptan al VERIFICAR un hash: lo que está en la base no es de fiar sin límites (un `N` enorme agotaría la memoria). */
const MIN_LOG2_N = 10;
const MAX_LOG2_N = 20;
const MAX_R = 16;
const MAX_P = 16;
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;

/** Formato del hash: `scrypt$<N>$<r>$<p>$<sal en base64url>$<derivación en base64url>`. Es el que exige el CHECK de `users.password_hash`. */
const HASH_PATTERN = /^scrypt\$([1-9][0-9]*)\$([1-9][0-9]*)\$([1-9][0-9]*)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

function derive(password: string, salt: Buffer, keyLength: number, params: ScryptParams): Promise<Buffer> {
  // `maxmem` con holgura: el tope por defecto de Node (32 MiB) rechaza N = 2^15 con r = 8 (necesita 128 * N * r = 32 MiB más overhead).
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 2 * 128 * params.N * params.r + 1024 * 1024 };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/**
 * Hash scrypt de una contraseña, con una sal aleatoria nueva y los parámetros codificados en el resultado
 * (`scrypt$N$r$p$sal$derivación`). La contraseña se normaliza a NFKC: el mismo texto escrito con otra composición Unicode es la misma
 * contraseña. La contraseña en claro nunca se guarda ni se registra.
 */
export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, params);
  return `${FORMAT}$${params.N}$${params.r}$${params.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parseHash(stored: string): ParsedHash | undefined {
  const match = HASH_PATTERN.exec(stored);
  if (match === null) return undefined;
  const [, n, r, p, salt, key] = match;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  const isPowerOfTwo = Number.isInteger(Math.log2(params.N));
  if (!isPowerOfTwo || params.N < 2 ** MIN_LOG2_N || params.N > 2 ** MAX_LOG2_N) return undefined;
  if (params.r > MAX_R || params.p > MAX_P || 128 * params.N * params.r > MAX_MEMORY_BYTES) return undefined;
  const keyBytes = Buffer.from(key ?? "", "base64url");
  if (keyBytes.length === 0) return undefined;
  return { params, salt: Buffer.from(salt ?? "", "base64url"), key: keyBytes };
}

/**
 * Compara una contraseña con un hash de `hashPassword`, en tiempo constante. Devuelve `false` (nunca lanza) ante un hash con
 * formato inválido o con parámetros fuera de las cotas: el login no distingue "contraseña incorrecta" de "hash corrupto".
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed === undefined) return false;
  const candidate = await derive(password, parsed.salt, parsed.key.length, parsed.params);
  return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
}
