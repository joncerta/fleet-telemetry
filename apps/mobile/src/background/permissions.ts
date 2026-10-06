import * as Location from "expo-location";
import type { PermissionStatusDetailed, PermissionsSnapshot } from "../core/tracking-state";

function map(response: Location.LocationPermissionResponse): PermissionStatusDetailed {
  if (response.granted) return "granted";
  if (response.status === Location.PermissionStatus.UNDETERMINED) return "undetermined";
  return response.canAskAgain ? "denied" : "blocked";
}

export async function readPermissions(): Promise<PermissionsSnapshot> {
  const [foreground, background] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
  ]);
  return { foreground: map(foreground), background: map(background) };
}

/** Paso 1. */
export async function requestForeground(): Promise<PermissionStatusDetailed> {
  return map(await Location.requestForegroundPermissionsAsync());
}

/** Paso 2: SOLO después de mostrar la divulgación al conductor y de tener el primer plano. */
export async function requestBackground(): Promise<PermissionStatusDetailed> {
  return map(await Location.requestBackgroundPermissionsAsync());
}

export async function gpsEnabled(): Promise<boolean> {
  return Location.hasServicesEnabledAsync();
}
