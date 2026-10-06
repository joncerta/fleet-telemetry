export type BatteryStatus = "excluded" | "optimized" | "unknown";

export interface BatteryGuidance {
  readonly vendor: "xiaomi" | "samsung" | "huawei" | "generic";
  readonly title: string;
  readonly steps: readonly string[];
}

const GENERIC_STEPS = [
  "Abre Ajustes > Aplicaciones > Fleet Conductor > Batería.",
  "Elige \"Sin restricciones\" (o \"No optimizar\").",
] as const;

/** Estado visible: `isIgnoring` viene del módulo nativo (null si no se pudo consultar). */
export function batteryStatusOf(isIgnoring: boolean | null): BatteryStatus {
  if (isIgnoring === null) return "unknown";
  return isIgnoring ? "excluded" : "optimized";
}

/**
 * Guía por fabricante. Xiaomi, Huawei y Samsung matan procesos en segundo plano más agresivo que AOSP y tienen
 * ajustes propios además del "Sin restricciones" de Android.
 */
export function batteryGuidance(manufacturer: string | null | undefined): BatteryGuidance {
  const m = (manufacturer ?? "").trim().toLowerCase();
  if (m === "xiaomi" || m === "redmi" || m === "poco") {
    return {
      vendor: "xiaomi",
      title: "Teléfono Xiaomi: evita que se cierre la app",
      steps: [
        "Ajustes > Aplicaciones > Fleet Conductor > Ahorro de batería: elige \"Sin restricciones\".",
        "Activa \"Inicio automático\" para Fleet Conductor.",
        "En Recientes, fija la app (candado) para que no se cierre.",
      ],
    };
  }
  if (m === "huawei" || m === "honor") {
    return {
      vendor: "huawei",
      title: "Teléfono Huawei: evita que se cierre la app",
      steps: [
        "Ajustes > Batería > Inicio de aplicaciones > Fleet Conductor: pasa a \"Administrar manualmente\".",
        "Activa \"Inicio automático\", \"Inicio secundario\" y \"Ejecutar en segundo plano\".",
      ],
    };
  }
  if (m === "samsung") {
    return {
      vendor: "samsung",
      title: "Teléfono Samsung: evita que se cierre la app",
      steps: [
        "Ajustes > Batería > Límites de uso en segundo plano: quita Fleet Conductor de \"Apps en suspensión\".",
        "Agrégala a \"Apps que nunca se suspenden\".",
        ...GENERIC_STEPS,
      ],
    };
  }
  return { vendor: "generic", title: "Evita que Android cierre la app", steps: GENERIC_STEPS };
}
