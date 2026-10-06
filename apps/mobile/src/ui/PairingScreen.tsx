import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { CredentialsInputError } from "../core/credentials";
import { Button, Card, styles as shared } from "./components";
import { colors, font, radius, spacing, touch } from "./theme";

const ERROR_TEXT: Record<CredentialsInputError, string> = {
  token_format: "El token no tiene el formato esperado (empieza con fdt_).",
  vehicle_format: "El identificador del vehículo debe ser un UUID.",
};

/**
 * Vinculación TEMPORAL por pegado manual. Cuando el backend entregue la vinculación con código de un solo uso
 * (`POST /v1/devices/pair`), esta pantalla pedirá el código y llamará al mismo `link` del modelo: la cola y el sync no cambian.
 */
export function PairingScreen(props: { onLink: (token: string, vehicleId: string) => Promise<CredentialsInputError | null> }) {
  const [token, setToken] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [error, setError] = useState<CredentialsInputError | null>(null);

  return (
    <View style={styles.wrap} testID="pairing-screen">
      <Card title="Vincular este dispositivo">
        <Text style={shared.body}>
          Pega el token y el identificador del vehículo que imprime el comando de desarrollo
          {" "}
          <Text style={styles.code}>pnpm device:token -- --vehicle PLACA</Text>.
        </Text>
        <Text style={shared.muted}>Token del dispositivo</Text>
        <TextInput
          testID="token-input"
          accessibilityLabel="Token del dispositivo"
          style={styles.input}
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder="fdt_..."
          placeholderTextColor={colors.textMuted}
        />
        <Text style={shared.muted}>Vehículo (UUID)</Text>
        <TextInput
          testID="vehicle-input"
          accessibilityLabel="Identificador del vehículo"
          style={styles.input}
          value={vehicleId}
          onChangeText={setVehicleId}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="00000000-0000-0000-0000-000000000000"
          placeholderTextColor={colors.textMuted}
        />
        {error !== null && (
          <Text style={styles.error} testID="pairing-error" accessibilityRole="alert">
            {ERROR_TEXT[error]}
          </Text>
        )}
        <Button
          label="Vincular"
          testID="link-button"
          onPress={() => {
            void props.onLink(token, vehicleId).then(setError);
          }}
        />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: spacing.lg, gap: spacing.lg },
  input: {
    minHeight: touch.min,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: font.body,
    color: colors.text,
    backgroundColor: colors.background,
  },
  error: { color: colors.danger, fontSize: font.body, fontWeight: "600" },
  code: { fontFamily: "monospace", fontSize: font.small },
});
