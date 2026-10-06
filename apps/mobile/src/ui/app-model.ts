import NetInfo from "@react-native-community/netinfo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, PermissionsAndroid, Platform } from "react-native";
import { isIgnoringBatteryOptimizations } from "../../modules/battery-optimization";
import { gpsEnabled as readGpsEnabled, readPermissions, requestBackground, requestForeground } from "../background/permissions";
import { endShift, isTracking, startShift } from "../background/tracking";
import { batteryStatusOf, type BatteryStatus } from "../core/battery-guidance";
import type { DeviceCredentials } from "../core/credentials";
import { pairDevice, type PairResult } from "../core/pairing";
import { connectionStateOf, readDiagnostics, type ConnectionState, type Diagnostics } from "../core/diagnostics";
import { SyncScheduler } from "../core/sync-scheduler";
import {
  deriveTrackingState,
  nextPermissionStep,
  type PermissionsSnapshot,
  type TrackingState,
} from "../core/tracking-state";
import { logEvent } from "../infra/log";
import { getRuntime, type Runtime } from "../runtime";

const POLL_MS = 1_500;
const UNKNOWN_PERMISSIONS: PermissionsSnapshot = { foreground: "undetermined", background: "undetermined" };

export type ShiftPrompt = "none" | "background_disclosure" | "blocked";

export interface AppModel {
  readonly ready: boolean;
  readonly startupError: boolean;
  readonly credentials: DeviceCredentials | null;
  readonly diagnostics: Diagnostics | null;
  readonly connection: ConnectionState;
  readonly permissions: PermissionsSnapshot;
  readonly tracking: TrackingState;
  readonly shiftActive: boolean;
  readonly battery: BatteryStatus;
  readonly prompt: ShiftPrompt;
  readonly busy: boolean;
  readonly link: (code: string) => Promise<PairResult>;
  readonly unlink: () => Promise<void>;
  /** Iniciar turno: encadena los permisos en orden (primer plano, divulgación, segundo plano) y arranca el tracking. */
  readonly startShift: () => Promise<void>;
  readonly confirmBackgroundDisclosure: () => Promise<void>;
  readonly dismissPrompt: () => void;
  readonly stopShift: () => Promise<void>;
  readonly openAppSettings: () => void;
  readonly syncNow: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}

/**
 * Estado de la app para la UI. SOLO observa y delega: la captura vive en la tarea en segundo plano y el sync en el motor.
 * Nada de aquí es necesario para que se capture o se envíe.
 */
export function useAppModel(): AppModel {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [startupError, setStartupError] = useState(false);
  const [credentials, setCredentials] = useState<DeviceCredentials | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("unknown");
  const [permissions, setPermissions] = useState<PermissionsSnapshot>(UNKNOWN_PERMISSIONS);
  const [gps, setGps] = useState(true);
  const [shiftActive, setShiftActive] = useState(false);
  const [battery, setBattery] = useState<BatteryStatus>("unknown");
  const [prompt, setPrompt] = useState<ShiftPrompt>("none");
  const [busy, setBusy] = useState(false);
  const scheduler = useRef<SyncScheduler | null>(null);

  const refresh = useCallback(async () => {
    const rt = await getRuntime();
    const [creds, diag, perms, gpsOn, tracking] = await Promise.all([
      rt.credentials.get(),
      readDiagnostics(rt.store),
      readPermissions(),
      readGpsEnabled(),
      isTracking(),
    ]);
    setCredentials(creds);
    setDiagnostics(diag);
    setPermissions(perms);
    setGps(gpsOn);
    setShiftActive(tracking);
    setBattery(batteryStatusOf(isIgnoringBatteryOptimizations()));
  }, []);

  // Arranque: runtime, scheduler, red y primer plano.
  useEffect(() => {
    let cancelled = false;
    getRuntime()
      .then(async (rt) => {
        if (cancelled) return;
        setRuntime(rt);
        const s = new SyncScheduler({
          drain: (options) => rt.engine.drain(options),
          pendingCount: async () => {
            const c = await rt.store.counts();
            return c.pending + c.inFlight;
          },
        });
        scheduler.current = s;
        s.start();
        await refresh();
      })
      .catch(() => setStartupError(true));

    const unsubscribeNet = NetInfo.addEventListener((state) => {
      setConnection(connectionStateOf(state));
      scheduler.current?.setReachable(state.isInternetReachable);
    });
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        scheduler.current?.onForeground();
        void refresh();
      }
    });
    return () => {
      cancelled = true;
      scheduler.current?.stop();
      unsubscribeNet();
      appState.remove();
    };
  }, [refresh]);

  // Sondeo liviano para que contadores y estados se vean al vuelo.
  useEffect(() => {
    if (runtime === null) return;
    const id = setInterval(() => void refresh().catch(() => undefined), POLL_MS);
    return () => clearInterval(id);
  }, [runtime, refresh]);

  const link = useCallback(
    async (code: string): Promise<PairResult> => {
      const rt = await getRuntime();
      // Vincular (o re-vincular) NO toca el turno: solo reemplaza credenciales y reanuda el sync.
      const result = await pairDevice({
        rawCode: code,
        transport: rt.pairing,
        credentials: rt.credentials,
        onPaired: () => rt.engine.resume(),
        nowMs: Date.now(),
      });
      if (result.ok) {
        await refresh();
        scheduler.current?.onForeground();
      }
      return result;
    },
    [refresh],
  );

  const unlink = useCallback(async () => {
    if (await isTracking()) await endShift();
    const rt = await getRuntime();
    await rt.credentials.clear();
    await refresh();
  }, [refresh]);

  const begin = useCallback(async () => {
    // Android 13+: sin este permiso la notificación del foreground service no se muestra (el servicio igual corre).
    if (Platform.OS === "android" && Platform.Version >= 33) {
      await PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS").catch(() => undefined);
    }
    await startShift();
    logEvent("shift_started");
    await refresh();
  }, [refresh]);

  const advance = useCallback(async () => {
    let perms = await readPermissions();
    for (let guard = 0; guard < 3; guard++) {
      const step = nextPermissionStep(perms);
      if (step === "request_foreground") {
        await requestForeground();
        perms = await readPermissions();
        continue;
      }
      if (step === "explain_then_request_background") {
        setPermissions(perms);
        setPrompt("background_disclosure"); // la divulgación se muestra ANTES de pedir el de segundo plano
        return;
      }
      if (step === "open_settings") {
        setPermissions(perms);
        setPrompt("blocked");
        return;
      }
      setPrompt("none");
      await begin();
      return;
    }
    setPermissions(perms);
    // Un primer plano rechazado sin "no volver a preguntar" deja el paso en request_foreground: se informa.
    setPrompt("blocked");
  }, [begin]);

  const guarded = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      logEvent("ui_action_failed", { name: error instanceof Error ? error.name : "unknown" });
    } finally {
      setBusy(false);
    }
  }, []);

  return useMemo<AppModel>(
    () => ({
      ready: runtime !== null,
      startupError,
      credentials,
      diagnostics,
      connection,
      permissions,
      tracking: deriveTrackingState({ shiftActive, permissions, gpsEnabled: gps }),
      shiftActive,
      battery,
      prompt,
      busy,
      link,
      unlink,
      startShift: () => guarded(advance),
      confirmBackgroundDisclosure: () =>
        guarded(async () => {
          setPrompt("none");
          await requestBackground();
          await advance();
        }),
      dismissPrompt: () => setPrompt("none"),
      stopShift: () =>
        guarded(async () => {
          await endShift();
          logEvent("shift_ended");
          await refresh();
        }),
      openAppSettings: () => void Linking.openSettings(),
      syncNow: () =>
        guarded(async () => {
          const rt = await getRuntime();
          await rt.engine.drain({ force: true });
          await refresh();
        }),
      refresh,
    }),
    [runtime, startupError, credentials, diagnostics, connection, permissions, shiftActive, gps, battery, prompt, busy, link, unlink, guarded, advance, refresh],
  );
}
