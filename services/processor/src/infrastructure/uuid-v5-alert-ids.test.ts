import { ALERT_ID_NAMESPACE, alertIdName } from "@fleet/contracts";
import { describe, expect, it } from "vitest";
import { createAlertIdGenerator, uuidV5 } from "./uuid-v5-alert-ids.js";

const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const VEHICLE = "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71";

describe("uuidV5", () => {
  it("coincide con el vector de referencia de la documentación de Python (uuid5(NAMESPACE_DNS, 'python.org'))", () => {
    expect(uuidV5("python.org", DNS_NAMESPACE)).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  it("coincide con la implementación de referencia para nombres con caracteres no ASCII (UTF-8)", () => {
    expect(uuidV5("ñandú|✓", ALERT_ID_NAMESPACE)).toBe("7691e4e2-5869-5c26-ad3e-4e3f5ba63a8b");
  });

  it("es determinista y cambia con el nombre o con el namespace", () => {
    expect(uuidV5("a", DNS_NAMESPACE)).toBe(uuidV5("a", DNS_NAMESPACE));
    expect(uuidV5("a", DNS_NAMESPACE)).not.toBe(uuidV5("b", DNS_NAMESPACE));
    expect(uuidV5("a", DNS_NAMESPACE)).not.toBe(uuidV5("a", ALERT_ID_NAMESPACE));
  });

  it("lleva la versión 5 y la variante RFC 4122", () => {
    expect(uuidV5("cualquier cosa", DNS_NAMESPACE)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("rechaza un namespace que no es un uuid", () => {
    expect(() => uuidV5("a", "no-es-un-uuid")).toThrow(/uuid/);
  });
});

describe("createAlertIdGenerator", () => {
  const generator = createAlertIdGenerator();

  it("usa el namespace del contrato: uuidv5(alertIdName(...), ALERT_ID_NAMESPACE) coincide con la implementación de referencia", () => {
    expect(generator.generate(alertIdName(VEHICLE, "critical_zone_stop", "2026-03-14T10:00:00.000Z"))).toBe("4cf55448-3962-55da-8603-eccff932a311");
    expect(generator.generate(alertIdName(VEHICLE, "mocked_location", "2026-03-14T10:00:00.000Z"))).toBe("13a43421-090d-558a-8c86-113b100201fc");
  });

  it("el mismo hecho con otro offset horario es la misma alerta; otro tipo o instante, otra", () => {
    const base = generator.generate(alertIdName(VEHICLE, "critical_zone_stop", "2026-03-14T10:00:00.000Z"));

    expect(generator.generate(alertIdName(VEHICLE.toUpperCase(), "critical_zone_stop", "2026-03-14T05:00:00.000-05:00"))).toBe(base);
    expect(generator.generate(alertIdName(VEHICLE, "mocked_location", "2026-03-14T10:00:00.000Z"))).not.toBe(base);
    expect(generator.generate(alertIdName(VEHICLE, "critical_zone_stop", "2026-03-14T10:00:00.001Z"))).not.toBe(base);
  });
});
