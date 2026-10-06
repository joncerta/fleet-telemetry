import { requireOptionalNativeModule } from "expo";

interface BatteryOptimizationNative {
  isIgnoringBatteryOptimizations(): boolean;
}

const native = requireOptionalNativeModule<BatteryOptimizationNative>("BatteryOptimization");

/** `true`: la app está EXCLUIDA del ahorro de batería (bien). `null`: no se pudo saber (módulo ausente). */
export function isIgnoringBatteryOptimizations(): boolean | null {
  return native === null ? null : native.isIgnoringBatteryOptimizations();
}
