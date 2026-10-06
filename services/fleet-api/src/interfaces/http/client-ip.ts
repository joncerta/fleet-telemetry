import { isIPv6 } from "node:net";

const GROUPS = 8;
const HEXTET = /^[0-9a-f]{1,4}$/;

/** Las dos mitades de una IPv4 en notación decimal con puntos, como los dos últimos grupos hexadecimales de una IPv6. */
function ipv4TailToHextets(address: string): string {
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (!tail.includes(".")) return address;
  const octets = tail.split(".").map(Number);
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  return `${address.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

/** Los 8 grupos de 16 bits de una IPv6 válida (`isIPv6`), o `undefined` si no se pudo leer. */
function hextetsOf(address: string): number[] | undefined {
  const [head = "", tail, ...extra] = ipv4TailToHextets(address).toLowerCase().split("::");
  if (extra.length > 0) return undefined;
  const parse = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const before = parse(head);
  const after = tail === undefined ? [] : parse(tail);
  const missing = GROUPS - before.length - after.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return undefined;
  const groups = [...before, ...Array.from({ length: tail === undefined ? 0 : missing }, () => "0"), ...after];
  if (!groups.every((group) => HEXTET.test(group))) return undefined;
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * Key de una IP de cliente para los límites por IP. Un cliente IPv6 controla un /64 entero (su operador le delega al menos
 * eso): contar por dirección completa dejaría rotar de IP a cada petición y esquivar el límite. Por eso:
 * - una IPv6 se reduce a su /64 (`2001:db8:1:2::/64`), escrita siempre igual (minúsculas, sin ceros a la izquierda);
 * - una IPv4 mapeada en IPv6 (`::ffff:198.51.100.9`, que es lo que da un socket de doble pila) es la IPv4 de origen;
 * - una IPv4 queda como está, y lo que no es una IP se devuelve sin tocar.
 * El identificador de zona (`%eth0`) se ignora. Es la misma regla que aplica por defecto `@fastify/rate-limit` al tope contra
 * floods, para que ambos límites agrupen igual.
 */
export function clientIpKey(ip: string): string {
  const address = ip.split("%", 1)[0] ?? ip;
  if (!isIPv6(address)) return ip;
  const groups = hextetsOf(address);
  if (groups === undefined) return ip;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  // Siempre los 4 grupos del prefijo, sin comprimir: todos los /64 se escriben con la misma forma.
  return `${[g0, g1, g2, g3].map((group) => group.toString(16)).join(":")}::/64`;
}
