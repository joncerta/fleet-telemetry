import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Mínimo del secreto de firma, en bytes: el tamaño de la salida de HMAC-SHA256. */
export const SESSION_SECRET_MIN_BYTES = 32;

/** Identidad que viaja firmada en la cookie de sesión. `exp` es el vencimiento en segundos desde la época Unix (UTC). */
export interface SessionClaims {
  readonly userId: string;
  readonly tenantId: string;
  readonly exp: number;
}

export interface SessionCodec {
  /** Token `v1.<claims en base64url>.<firma en base64url>`. Lanza si los claims no son válidos. */
  sign(claims: SessionClaims): string;
  /**
   * Los claims de un token firmado con este secreto y que no ha vencido a `nowMs` (por defecto, ahora), o `undefined` por
   * cualquier otra razón (formato, firma, claims o vencimiento). Nunca lanza ni dice por qué falló: el llamador responde un 401 genérico.
   */
  verify(token: string, nowMs?: number): SessionClaims | undefined;
}

const VERSION = "v1";
/** Un token legítimo mide ~200 caracteres: acotar la entrada evita trabajar sobre cabeceras gigantes. */
const MAX_TOKEN_LENGTH = 1_024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const claimsSchema = z.object({
  userId: z.uuid(),
  tenantId: z.uuid(),
  exp: z.number().int().positive(),
});

/**
 * Códec de la sesión firmada: HMAC-SHA256 sobre `v1.<payload>`, verificación en tiempo constante y rechazo si venció. Es
 * infraestructura compartida (fleet-api emite la cookie; el agente la valida): no sabe de usuarios ni de reglas de negocio.
 *
 * El token NO va cifrado: solo lleva identificadores opacos (uuid), nunca el correo ni el nombre. La versión (`v1`) va dentro de lo
 * firmado, para poder cambiar el formato sin aceptar tokens viejos con otra interpretación. El `secret` se valida al crear el
 * códec (al menos 32 bytes) y nunca se incluye en un mensaje de error.
 */
export function createSessionCodec(secret: string): SessionCodec {
  if (Buffer.byteLength(secret, "utf8") < SESSION_SECRET_MIN_BYTES) {
    throw new Error(`El secreto de sesión debe tener al menos ${SESSION_SECRET_MIN_BYTES} bytes.`);
  }
  const key = Buffer.from(secret, "utf8");
  const signatureOf = (signed: string): Buffer => createHmac("sha256", key).update(signed, "utf8").digest();

  return {
    sign(claims) {
      const parsed = claimsSchema.parse(claims);
      const payload = Buffer.from(JSON.stringify({ userId: parsed.userId, tenantId: parsed.tenantId, exp: parsed.exp }), "utf8").toString("base64url");
      const signed = `${VERSION}.${payload}`;
      return `${signed}.${signatureOf(signed).toString("base64url")}`;
    },

    verify(token, nowMs = Date.now()) {
      if (token.length > MAX_TOKEN_LENGTH) return undefined;
      const parts = token.split(".");
      if (parts.length !== 3) return undefined;
      const [version, payload, signature] = parts;
      if (version !== VERSION || payload === undefined || signature === undefined) return undefined;
      if (!BASE64URL.test(payload) || !BASE64URL.test(signature)) return undefined;

      const given = Buffer.from(signature, "base64url");
      const expected = signatureOf(`${version}.${payload}`);
      // `timingSafeEqual` exige el mismo largo; el de una firma válida es fijo (32 bytes), así que comparar el largo no filtra nada.
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;

      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return undefined;
      }
      const claims = claimsSchema.safeParse(decoded);
      if (!claims.success) return undefined;
      // Venció si `exp` (segundos) ya pasó: en el instante exacto ya no vale.
      if (claims.data.exp * 1_000 <= nowMs) return undefined;
      return claims.data;
    },
  };
}
