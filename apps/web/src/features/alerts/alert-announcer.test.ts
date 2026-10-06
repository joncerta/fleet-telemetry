import { describe, expect, it } from "vitest";
import { alert } from "../../test-support/fixtures";
import { createAlertAnnouncer } from "./alert-announcer";

const byId = (...alerts: ReturnType<typeof alert>[]) => Object.fromEntries(alerts.map((item) => [item.alertId, item]));

describe("createAlertAnnouncer", () => {
  it("no anuncia las alertas del primer snapshot", () => {
    const announcer = createAlertAnnouncer();
    expect(announcer.observe({ ready: true, alerts: byId(alert(), alert()) })).toBeNull();
  });

  it("no anuncia nada mientras no hay datos listos", () => {
    const announcer = createAlertAnnouncer();
    expect(announcer.observe({ ready: false, alerts: byId(alert()) })).toBeNull();
  });

  it("anuncia una alerta nueva en vivo UNA sola vez (la crítica por la región assertive)", () => {
    const announcer = createAlertAnnouncer();
    const first = alert({ plate: "NRT101" });
    announcer.observe({ ready: true, alerts: byId(first) });

    const fresh = alert({ plate: "NRT102", type: "critical_zone_stop" });
    const alerts = byId(first, fresh);
    const announcement = announcer.observe({ ready: true, alerts });
    expect(announcement?.assertive).toContain("NRT102");
    expect(announcement?.polite).toBeNull();

    // Mismo estado, o el mismo contenido en un objeto nuevo: no se repite.
    expect(announcer.observe({ ready: true, alerts })).toBeNull();
    expect(announcer.observe({ ready: true, alerts: { ...alerts } })).toBeNull();
  });

  it("las advertencias van por polite y varias del mismo lote son UNA frase", () => {
    const announcer = createAlertAnnouncer();
    announcer.observe({ ready: true, alerts: {} });
    const announcement = announcer.observe({
      ready: true,
      alerts: byId(alert({ type: "mocked_location", plate: "NRT103" }), alert({ type: "mocked_location", plate: "NRT104" })),
    });
    expect(announcement?.polite).toContain("2 alertas nuevas");
    expect(announcement?.assertive).toBeNull();
  });

  it("no anuncia las resueltas", () => {
    const announcer = createAlertAnnouncer();
    announcer.observe({ ready: true, alerts: {} });
    expect(announcer.observe({ ready: true, alerts: byId(alert({ resolvedAt: "2026-10-06T15:01:00.000Z" })) })).toBeNull();
  });

  it("reconexión: lo ya visto no se repite; lo ocurrido durante el corte se anuncia una vez", () => {
    const announcer = createAlertAnnouncer();
    const seen = alert({ plate: "NRT101" });
    announcer.observe({ ready: true, alerts: byId(seen) });

    // Snapshot de la reconexión (mismas alertas) y luego el historial de /v1/alerts con una nueva.
    expect(announcer.observe({ ready: true, alerts: byId(seen) })).toBeNull();
    const missed = alert({ plate: "NRT105" });
    expect(announcer.observe({ ready: true, alerts: byId(seen, missed) })?.assertive).toContain("NRT105");
    expect(announcer.observe({ ready: true, alerts: byId(seen, missed) })).toBeNull();
  });

  it("al cerrar sesión se olvida todo: el siguiente snapshot vuelve a ser 'el primero'", () => {
    const announcer = createAlertAnnouncer();
    announcer.observe({ ready: true, alerts: byId(alert()) });
    announcer.observe({ ready: false, alerts: {} });
    expect(announcer.observe({ ready: true, alerts: byId(alert({ plate: "SUR101" })) })).toBeNull();
  });
});
