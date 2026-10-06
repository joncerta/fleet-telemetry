import * as Device from "expo-device";
import * as IntentLauncher from "expo-intent-launcher";
import { StyleSheet, Text, View } from "react-native";
import { batteryGuidance } from "../core/battery-guidance";
import { errorLabel, pausedLabel, rejectReasonLabel, SYNC_LABEL } from "../core/labels";
import { syncSummaryOf } from "../core/diagnostics";
import { Button, Card, Row, styles as shared } from "./components";
import type { AppModel } from "./app-model";
import { colors, spacing } from "./theme";

const PERMISSION_LABEL = {
  granted: "Concedido",
  denied: "Denegado",
  blocked: "Bloqueado (ajustes)",
  undetermined: "Sin preguntar",
} as const;

function time(iso: string | null): string {
  return iso === null ? "Nunca" : new Date(iso).toLocaleTimeString("es-CO");
}

export function DiagnosticsScreen({ model }: { model: AppModel }) {
  const d = model.diagnostics;
  if (d === null) {
    return (
      <View style={styles.wrap}>
        <Text style={shared.body}>Cargando diagnóstico...</Text>
      </View>
    );
  }
  const reasons = Object.entries(d.rejectedByReason);
  const guidance = batteryGuidance(Device.manufacturer);
  const skew = d.clockSkewMs === null ? "Sin dato" : `${(d.clockSkewMs / 1000).toFixed(1)} s`;

  return (
    <View style={styles.wrap} testID="diagnostics-screen">
      <Card title="Cola de envío">
        <Row label="Pendientes" value={String(d.counts.pending)} testID="diag-pending" />
        <Row label="En vuelo" value={String(d.counts.inFlight)} testID="diag-in-flight" />
        <Row label="Enviados" value={String(d.counts.sent)} testID="diag-sent" />
        <Row label="Rechazados" value={String(d.counts.rejected)} testID="diag-rejected" />
        <Row label="Lotes fallidos (400)" value={String(d.counts.dead)} testID="diag-dead" />
        <Row label="Descartados por tope" value={String(d.counts.discarded)} testID="diag-discarded" />
        <Row label="Puntos inválidos al capturar" value={String(d.counts.invalidLocal)} testID="diag-invalid" />
        <Row label="Fallos de la tarea en segundo plano" value={String(d.counts.taskFailures)} testID="diag-task-failures" />
      </Card>

      {reasons.length > 0 && (
        <Card title="Rechazados por motivo" testID="diag-reasons">
          {reasons.map(([reason, count]) => (
            <Row key={reason} label={rejectReasonLabel(reason)} value={String(count)} />
          ))}
        </Card>
      )}

      <Card title="Sincronización" tone={d.pausedReason !== null ? "danger" : "default"}>
        <Row label="Estado" value={SYNC_LABEL[syncSummaryOf(d, Date.now())]} testID="diag-sync-state" />
        {pausedLabel(d.pausedReason) !== null && <Row label="Detenido" value={pausedLabel(d.pausedReason) ?? ""} testID="diag-paused" />}
        <Row label="Último envío exitoso" value={time(d.lastSyncAt)} testID="diag-last-sync" />
        <Row label="Hora del servidor (último ACK)" value={time(d.lastServerTime)} testID="diag-server-time" />
        <Row
          label="Último ACK"
          value={d.lastAckAccepted === null ? "Ninguno" : `${d.lastAckAccepted} aceptados, ${d.lastAckRejected ?? 0} rechazados`}
          testID="diag-last-ack"
        />
        <Row label="Desfase del reloj" value={skew} />
        <Row label="Último error" value={errorLabel(d.lastError)} testID="diag-last-error" />
        {d.lastError !== null && <Row label="Hora del error" value={time(d.lastErrorAt)} />}
        <Button label="Enviar ahora" variant="secondary" testID="sync-now" onPress={() => void model.syncNow()} disabled={model.busy} />
      </Card>

      <Card title="GPS y permisos">
        <Row label="Estado del tracking" value={model.tracking} testID="diag-tracking" />
        <Row label="Ubicación en primer plano" value={PERMISSION_LABEL[model.permissions.foreground]} />
        <Row label="Ubicación en segundo plano" value={PERMISSION_LABEL[model.permissions.background]} />
        <Row label="Último punto capturado" value={d.lastFixAt === null ? "Ninguno" : new Date(d.lastFixAt).toLocaleTimeString("es-CO")} />
      </Card>

      <Card title="Ahorro de batería" tone={model.battery === "optimized" ? "warn" : "default"} testID="battery-card">
        <Row
          label="Estado"
          value={model.battery === "excluded" ? "Excluida (correcto)" : model.battery === "optimized" ? "Optimizada (puede cerrarse)" : "Desconocido"}
          testID="diag-battery"
        />
        {model.battery !== "excluded" && (
          <>
            <Text style={shared.body}>{guidance.title}</Text>
            {guidance.steps.map((step, i) => (
              <Text key={step} style={shared.muted}>{`${i + 1}. ${step}`}</Text>
            ))}
            <Button
              label="Abrir ajustes de batería"
              variant="secondary"
              testID="open-battery-settings"
              onPress={() => void IntentLauncher.startActivityAsync("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS")}
            />
          </>
        )}
      </Card>

      <Card title="Dispositivo">
        <Row label="Vehículo vinculado" value={model.credentials === null ? "No" : "Sí"} testID="diag-linked" />
        <Button label="Desvincular dispositivo" variant="secondary" testID="unlink" onPress={() => void model.unlink()} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: spacing.lg, gap: spacing.lg, backgroundColor: colors.background },
});
