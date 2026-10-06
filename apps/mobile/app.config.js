/* global process, module, require */
/* eslint-disable @typescript-eslint/no-require-imports */
// Config de Expo. Es JS (CommonJS) y no app.json porque el HTTP en claro depende del perfil de build.
//
// HTTP en claro (Android lo bloquea por defecto): SOLO con APP_VARIANT=development. Sin la variable el build es de
// producción (falla en cerrado). En local hay que definir APP_VARIANT=development (ver .env.example).
const { resolveVariant, allowsCleartext } = require("./config/variant.cjs");
const variant = resolveVariant(process.env.APP_VARIANT);
const allowCleartext = allowsCleartext(variant);

/** @type {import("expo/config").ExpoConfig} */
module.exports = {
  name: "Fleet Conductor",
  slug: "fleet-driver",
  scheme: "fleetdriver",
  version: "0.1.0",
  // Coherente con `version`: un binario solo recibiría un update OTA de su misma versión de app. Hoy no hay `expo-updates` (no hay OTA);
  // si se agrega, esta política evita enviar JS nuevo a un binario con código nativo distinto.
  runtimeVersion: { policy: "appVersion" },
  orientation: "portrait",
  userInterfaceStyle: "light",
  newArchEnabled: true,
  android: {
    package: "co.fleet.driver",
    // Solo para builds locales: en EAS manda `appVersionSource: "remote"` (eas.json) y el `autoIncrement` del perfil `production`.
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
