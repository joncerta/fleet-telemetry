import { describe, expect, it } from "vitest";
import { clientIpKey } from "./client-ip.js";

describe("clientIpKey", () => {
  it("deja una IPv4 tal cual", () => {
    expect(clientIpKey("198.51.100.9")).toBe("198.51.100.9");
  });

  it.each([
    ["::ffff:198.51.100.9"],
    ["::FFFF:198.51.100.9"],
    ["0:0:0:0:0:ffff:198.51.100.9"],
    ["::ffff:c633:6409"],
  ])("trata la IPv4 mapeada en IPv6 %s como la IPv4 de origen", (mapped) => {
    expect(clientIpKey(mapped)).toBe("198.51.100.9");
  });

  it("una IPv6 se reduce a su /64: los 64 bits de interfaz no cambian la key", () => {
    const key = clientIpKey("2001:db8:aaaa:bbbb:1111:2222:3333:4444");

    expect(key).toBe("2001:db8:aaaa:bbbb::/64");
    expect(clientIpKey("2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff")).toBe(key);
    expect(clientIpKey("2001:db8:aaaa:bbbb::1")).toBe(key);
  });

  it("dos IPv6 de /64 distintos tienen keys distintas", () => {
    expect(clientIpKey("2001:db8:aaaa:bbbb::1")).not.toBe(clientIpKey("2001:db8:aaaa:bbbc::1"));
  });

  it("la forma comprimida, la expandida y las mayúsculas dan la misma key", () => {
    const expected = "2001:db8:0:1::/64";

    expect(clientIpKey("2001:db8:0:1::5")).toBe(expected);
    expect(clientIpKey("2001:0DB8:0000:0001:0000:0000:0000:0005")).toBe(expected);
    expect(clientIpKey("2001:db8::1:0:0:0:5")).toBe(expected);
  });

  it("maneja las direcciones con '::' al inicio y al final", () => {
    expect(clientIpKey("::1")).toBe("0:0:0:0::/64");
    expect(clientIpKey("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(clientIpKey("::")).toBe("0:0:0:0::/64");
  });

  it("ignora el identificador de zona", () => {
    expect(clientIpKey("fe80::1%eth0")).toBe(clientIpKey("fe80::2"));
  });

  it("lo que no es una IP se devuelve sin tocar (no debería ocurrir con request.ip)", () => {
    expect(clientIpKey("desconocida")).toBe("desconocida");
  });
});
