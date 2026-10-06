import { StyleSheet, Text, View } from "react-native";
import { Button, Card, styles as shared } from "./components";
import type { AppModel } from "./app-model";
import { colors, font, spacing } from "./theme";

export function ShiftScreen({ model }: { model: AppModel }) {
  const pending = (model.diagnostics?.counts.pending ?? 0) + (model.diagnostics?.counts.inFlight ?? 0);
  return (
    <View style={styles.wrap} testID="shift-screen">
      <Card>
        <Text style={styles.big} testID="shift-title">
          {model.shiftActive ? "Turno activo" : "Turno detenido"}
        </Text>
        <Text style={shared.body}>
          {model.shiftActive
            ? "La app registra tu ruta aunque la pantalla esté apagada. Verás una notificación mientras dure el turno."
            : "Inicia el turno para empezar a registrar tu ruta."}
        </Text>
        {model.shiftActive ? (
          <Button label="Terminar turno" variant="danger" testID="stop-shift" onPress={() => void model.stopShift()} disabled={model.busy} />
        ) : (
          <Button label="Iniciar turno" testID="start-shift" onPress={() => void model.startShift()} disabled={model.busy} />
        )}
        {pending > 0 && !model.shiftActive && (
          <Text style={shared.muted} testID="shift-pending-note">
            Quedan {pending} puntos por enviar; se enviarán solos cuando haya conexión.
          </Text>
        )}
      </Card>

      {model.prompt === "background_disclosure" && (
        <Card title="Ubicación en segundo plano" tone="warn" testID="background-disclosure">
          <Text style={shared.body}>
            Fleet Conductor recoge la ubicación de tu vehículo, incluso cuando la app está cerrada o la pantalla apagada, solo
            mientras tu turno está activo. Se usa para mostrar la posición del vehículo a tu empresa y no se recoge fuera del turno.
          </Text>
          <Text style={shared.body}>
            En la siguiente pantalla elige &quot;Permitir todo el tiempo&quot;.
          </Text>
          <Button label="Entendido, continuar" testID="disclosure-continue" onPress={() => void model.confirmBackgroundDisclosure()} />
          <Button label="Ahora no" variant="secondary" testID="disclosure-cancel" onPress={model.dismissPrompt} />
        </Card>
      )}

      {model.prompt === "blocked" && (
        <Card title="Falta el permiso de ubicación" tone="danger" testID="permission-blocked">
          <Text style={shared.body}>Sin el permiso &quot;Permitir todo el tiempo&quot; no se puede registrar tu ruta con la pantalla apagada.</Text>
          <Text style={shared.body}>1. Toca &quot;Abrir ajustes&quot;.</Text>
          <Text style={shared.body}>2. Entra a Permisos &gt; Ubicación.</Text>
          <Text style={shared.body}>3. Elige &quot;Permitir todo el tiempo&quot; y vuelve a la app.</Text>
          <Button label="Abrir ajustes" testID="open-settings" onPress={model.openAppSettings} />
          <Button label="Cerrar" variant="secondary" onPress={model.dismissPrompt} />
        </Card>
      )}

      {model.tracking === "no_signal" && (
        <Card tone="warn" testID="no-signal-card">
          <Text style={shared.body}>El GPS del teléfono está apagado. Enciende la ubicación para seguir registrando la ruta.</Text>
        </Card>
      )}

      {model.diagnostics?.pausedReason != null && (
        <Card tone="danger" testID="unlinked-card">
          <Text style={[shared.body, { color: colors.danger }]}>Dispositivo no vinculado. Los puntos se guardan, pero no se envían.</Text>
          <Text style={shared.muted}>Vuelve a pegar el token en la pantalla de vinculación (pestaña Vincular).</Text>
        </Card>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: spacing.lg, gap: spacing.lg },
  big: { fontSize: font.title + 4, fontWeight: "800", color: colors.text },
});
