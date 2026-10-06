import { StyleSheet, View } from "react-native";
import { CONNECTION_LABEL, TRACKING_LABEL } from "../core/labels";
import { Pill } from "./components";
import type { AppModel } from "./app-model";
import { colors, spacing } from "./theme";

/** Siempre visible: conexión, estado del tracking y puntos pendientes. Pensado para un vistazo. */
export function StatusHeader({ model }: { model: AppModel }) {
  const pending = (model.diagnostics?.counts.pending ?? 0) + (model.diagnostics?.counts.inFlight ?? 0);
  const trackingTone = { active: "ok", paused: "neutral", no_permission: "danger", no_signal: "warn" } as const;
  const connectionTone = { online: "ok", offline: "danger", unknown: "neutral" } as const;
  return (
    <View style={styles.wrap} testID="status-header">
      <Pill text={TRACKING_LABEL[model.tracking]} tone={trackingTone[model.tracking]} testID="tracking-state" />
      <Pill text={CONNECTION_LABEL[model.connection]} tone={connectionTone[model.connection]} testID="connection-state" />
      <Pill text={`Pendientes: ${pending}`} tone={pending > 0 ? "warn" : "ok"} testID="pending-badge" />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
});
