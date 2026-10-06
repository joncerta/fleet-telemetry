import { describe, expect, it } from "vitest";
import { alert, VEHICLE_A, VEHICLE_B } from "../../test-support/fixtures";
import { announceNewAlerts, buildAlertFeed, severityOf } from "./alert-feed";

const at = (minute: number, second = 0) => `2026-10-06T15:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

describe("buildAlertFeed", () => {
  it("agrupa una ráfaga del mismo vehículo y tipo en un minuto en UNA fila", () => {
    const burst = Array.from({ length: 10 }, (_, index) => alert({ type: "mocked_location", raisedAt: at(0, index * 5) }));
    const groups = buildAlertFeed(burst);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 10, vehicleId: VEHICLE_A, type: "mocked_location" });
    expect(groups[0]?.latest.raisedAt).toBe(at(0, 45));
  });

  it("separa alertas del mismo vehículo más distantes que la ventana, y las de vehículos o tipos distintos", () => {
    const groups = buildAlertFeed([
      alert({ type: "mocked_location", raisedAt: at(0) }),
      alert({ type: "mocked_location", raisedAt: at(5) }),
      alert({ type: "critical_zone_stop", raisedAt: at(5) }),
      alert({ vehicleId: VEHICLE_B, plate: "NRT102", type: "mocked_location", raisedAt: at(5) }),
    ]);
    expect(groups).toHaveLength(4);
  });

  it("ordena: activas primero, luego por severidad y, a igual severidad, la más reciente primero", () => {
    const resolvedCritical = alert({ type: "critical_zone_stop", raisedAt: at(9), resolvedAt: at(10) });
    const oldCritical = alert({ vehicleId: VEHICLE_B, plate: "NRT102", type: "critical_zone_stop", raisedAt: at(1) });
    const newCritical = alert({ type: "critical_zone_stop", raisedAt: at(3) });
    const warning = alert({ type: "mocked_location", raisedAt: at(8) });
    const unknownType = alert({ type: "unknown", raisedAt: at(9) });

    const order = buildAlertFeed([warning, resolvedCritical, unknownType, oldCritical, newCritical]).map((group) => group.latest.alertId);
    expect(order).toEqual([newCritical.alertId, oldCritical.alertId, warning.alertId, unknownType.alertId, resolvedCritical.alertId]);
  });

  it("la severidad sale del tipo; un tipo desconocido es informativo", () => {
    expect(severityOf("critical_zone_stop")).toBe("critical");
    expect(severityOf("mocked_location")).toBe("warning");
    expect(severityOf("unknown")).toBe("info");
  });
});

describe("announceNewAlerts", () => {
  it("anuncia solo las activas que no se habían visto; las críticas en la región assertive", () => {
    const seen = alert({ type: "critical_zone_stop" });
    const critical = alert({ type: "critical_zone_stop", plate: "NRT105" });
    const warning = alert({ type: "mocked_location", plate: "NRT106" });
    const resolved = alert({ type: "mocked_location", resolvedAt: at(5) });

    const announcement = announceNewAlerts(new Set([seen.alertId]), [seen, critical, warning, resolved]);
    expect(announcement.assertive).toBe("Alerta crítica: Detenido en zona crítica, NRT105.");
    expect(announcement.polite).toBe("Nueva alerta: Ubicación simulada, NRT106.");
  });

  it("varias nuevas en el mismo lote se resumen en una sola frase", () => {
    const fresh = ["NRT101", "NRT102", "NRT103", "NRT104"].map((plate) => alert({ type: "mocked_location", plate }));
    expect(announceNewAlerts(new Set(), fresh).polite).toBe("Nueva alerta: 4 alertas nuevas (NRT101, NRT102, NRT103…).");
  });

  it("sin nada nuevo no anuncia nada", () => {
    const known = alert();
    expect(announceNewAlerts(new Set([known.alertId]), [known])).toEqual({ polite: null, assertive: null });
  });
});
