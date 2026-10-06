/* global process, module */
// Config de Expo. Es JS (CommonJS) y no app.json porque el HTTP en claro depende del perfil de build.
//
// HTTP en claro (Android lo bloquea por defecto): SOLO en desarrollo local. Los perfiles `preview` y `production`
// de EAS deben definir APP_VARIANT con ese nombre para que el APK/AAB salga sin él. Sin APP_VARIANT (local) se habilita.
const variant = process.env.APP_VARIANT ?? "development";
const allowCleartext = variant === "development";

/** @type {import("expo/config").ExpoConfig} */
module.exports = {
  name: "Fleet Conductor",
  slug: "fleet-driver",
  scheme: "fleetdriver",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  newArchEnabled: true,
  android: {
    package: "co.fleet.driver",
    versionCode: 1,
    permissions: [
      "ACCESS_COARSE_LOCATION",
      "ACCESS_FINE_LOCATION",
      "ACCESS_BACKGROUND_LOCATION",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_LOCATION",
      "POST_NOTIFICATIONS",
      // expo-task-manager programa un job persistente para entregar los fixes a la tarea: sin este permiso la app se
      // cae con "Requested job cannot be persisted" en cuanto llega la primera ubicación.
      "RECEIVE_BOOT_COMPLETED",
    ],
  },
  plugins: [
    [
      "expo-location",
      {
        // Segundo plano + foreground service con notificación visible mientras dura el turno.
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
        locationAlwaysAndWhenInUsePermission:
          "Fleet Conductor usa tu ubicación, incluso con la app en segundo plano, solo mientras tu turno está activo.",
        locationWhenInUsePermission: "Fleet Conductor usa tu ubicación mientras tu turno está activo.",
      },
    ],
    "expo-sqlite",
    "expo-secure-store",
    ["expo-build-properties", { android: { usesCleartextTraffic: allowCleartext } }],
  ],
  extra: {
    appVariant: variant,
  },
};
