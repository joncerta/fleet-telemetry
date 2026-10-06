import { PAIRING_CODE_LENGTH } from "@fleet/contracts";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { filterPairingInput, type PairResult } from "../core/pairing";
import { Button, Card, styles as shared } from "./components";
import { colors, font, radius, spacing, touch } from "./theme";

function messageOf(result: Extract<PairResult, { ok: false }>): string {
  switch (result.error) {
    case "code_format":
      return `El código tiene ${PAIRING_CODE_LENGTH} caracteres (letras y números).`;
    case "invalid_code":
      return "El código no es válido o ya venció. Pide uno nuevo a tu operador.";
    case "rate_limited":
      return result.retryAfterMs !== undefined
        ? `Demasiados intentos. Espera ${Math.ceil(result.retryAfterMs / 1000)} segundos.`
        : "Demasiados intentos. Espera un momento y vuelve a intentar.";
    case "network":
      return "Sin conexión con el servidor. Revisa tu red e intenta de nuevo.";
    case "config":
      return "La app no tiene configurada la dirección del servidor.";
    case "bad_response":
      return "El servidor respondió algo inesperado. Intenta de nuevo.";
    case "server":
      return "El servidor no pudo vincular el dispositivo. Intenta más tarde.";
  }
}

/** Vinculación con código de un solo uso (`POST /v1/devices/pair`). El vehículo sale del servidor: no hay campo editable. */
export function PairingScreen(props: { linked: boolean; onLink: (code: string) => Promise<PairResult> }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    setBusy(true);
    setError(null);
    props
      .onLink(code)
      .then((result) => {
        if (result.ok) setCode("");
        else setError(messageOf(result));
      })
      .catch(() => setError("No se pudo vincular. Intenta de nuevo."))
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.wrap} testID="pairing-screen">
      <Card title={props.linked ? "Vincular con otro código" : "Vincular este dispositivo"}>
        <Text style={shared.body}>
          Escribe el código de {PAIRING_CODE_LENGTH} caracteres que te dio tu operador. Es de un solo uso y vence pronto.
        </Text>
        {props.linked && <Text style={shared.muted}>Tu turno no se interrumpe al cambiar de vinculación.</Text>}
        <TextInput
          testID="code-input"
          accessibilityLabel="Código de vinculación"
          style={styles.input}
          value={code}
          onChangeText={(text) => setCode(filterPairingInput(text, PAIRING_CODE_LENGTH))}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={PAIRING_CODE_LENGTH}
          placeholder="ABCD2345"
          placeholderTextColor={colors.textMuted}
        />
        {error !== null && (
          <Text style={styles.error} testID="pairing-error" accessibilityRole="alert">
            {error}
          </Text>
        )}
        <Button label={busy ? "Vinculando..." : "Vincular"} testID="link-button" disabled={busy} onPress={submit} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: spacing.lg, gap: spacing.lg },
  input: {
    minHeight: touch.primary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: font.title,
    letterSpacing: 4,
    textAlign: "center",
    color: colors.text,
    backgroundColor: colors.background,
  },
  error: { color: colors.danger, fontSize: font.body, fontWeight: "600" },
});
