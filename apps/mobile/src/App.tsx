import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useAppModel } from "./ui/app-model";
import { DiagnosticsScreen } from "./ui/DiagnosticsScreen";
import { PairingScreen } from "./ui/PairingScreen";
import { ShiftScreen } from "./ui/ShiftScreen";
import { StatusHeader } from "./ui/StatusHeader";
import { colors, font, spacing, touch } from "./ui/theme";

type Tab = "shift" | "diagnostics" | "pairing";

const TABS: { id: Tab; label: string }[] = [
  { id: "shift", label: "Turno" },
  { id: "diagnostics", label: "Diagnóstico" },
  { id: "pairing", label: "Vincular" },
];

export function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const model = useAppModel();
  const [tab, setTab] = useState<Tab>("shift");

  if (model.startupError) {
    return (
      <SafeAreaView style={styles.safe}>
        <Text style={styles.error} testID="startup-error">No se pudo iniciar la app (base de datos local o configuración del servidor). Cierra la app y vuelve a abrirla.</Text>
      </SafeAreaView>
    );
  }
  if (!model.ready) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator accessibilityLabel="Cargando" />
      </SafeAreaView>
    );
  }

  // Sin vinculación solo se ve la pantalla de vinculación y el diagnóstico.
  const linked = model.credentials !== null;
  const active: Tab = !linked && tab === "shift" ? "pairing" : tab;

  return (
    <SafeAreaView style={styles.safe} testID="app-root">
      <StatusBar style="dark" />
      <StatusHeader model={model} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {active === "shift" && <ShiftScreen model={model} />}
        {active === "diagnostics" && <DiagnosticsScreen model={model} />}
        {active === "pairing" && (
          <PairingScreen
            linked={linked}
            onLink={(code) =>
              model.link(code).then((result) => {
                if (result.ok) setTab("shift");
                return result;
              })
            }
          />
        )}
      </ScrollView>
      <View style={styles.tabs} accessibilityRole="tablist">
        {TABS.map((t) => (
          <Pressable
            key={t.id}
            testID={`tab-${t.id}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: active === t.id }}
            style={[styles.tab, active === t.id && styles.tabActive]}
            onPress={() => setTab(t.id)}
          >
            <Text style={[styles.tabLabel, active === t.id && styles.tabLabelActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  content: { flexGrow: 1 },
  error: { padding: spacing.xl, fontSize: font.body, color: colors.danger },
  tabs: { flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  tab: { flex: 1, minHeight: touch.primary, alignItems: "center", justifyContent: "center", padding: spacing.sm },
  tabActive: { backgroundColor: colors.primary },
  tabLabel: { fontSize: font.body, fontWeight: "600", color: colors.text, textAlign: "center" },
  tabLabelActive: { color: colors.onPrimary },
});
