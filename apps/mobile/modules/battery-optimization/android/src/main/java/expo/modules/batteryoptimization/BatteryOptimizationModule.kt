package expo.modules.batteryoptimization

import android.content.Context
import android.os.PowerManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expone si Android exime a la app del ahorro de batería (Doze / App Standby). Solo lectura: abrir los ajustes
 * se hace desde JS con un intent, sin pedir el permiso REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (Google Play lo restringe).
 */
class BatteryOptimizationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BatteryOptimization")

    Function("isIgnoringBatteryOptimizations") {
      val context = appContext.reactContext ?: return@Function false
      val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      powerManager.isIgnoringBatteryOptimizations(context.packageName)
    }
  }
}
