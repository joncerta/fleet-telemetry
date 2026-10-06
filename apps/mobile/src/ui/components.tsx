import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { colors, font, radius, spacing, touch } from "./theme";

export function Button(props: {
  label: string;
  onPress: () => void;
  testID?: string;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const variant = props.variant ?? "primary";
  const palette = {
    primary: { bg: colors.primary, fg: colors.onPrimary, border: colors.primary },
    secondary: { bg: colors.surfaceStrong, fg: colors.text, border: colors.border },
    danger: { bg: colors.danger, fg: "#ffffff", border: colors.danger },
  }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      testID={props.testID}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: palette.bg, borderColor: palette.border, opacity: props.disabled ? 0.5 : pressed ? 0.85 : 1 },
        props.style,
      ]}
    >
      <Text style={[styles.buttonLabel, { color: palette.fg }]}>{props.label}</Text>
    </Pressable>
  );
}

export function Card(props: { title?: string; children: ReactNode; tone?: "default" | "warn" | "danger"; testID?: string }) {
  const border = props.tone === "danger" ? colors.danger : props.tone === "warn" ? colors.warn : colors.border;
  return (
    <View style={[styles.card, { borderColor: border }]} testID={props.testID}>
      {props.title !== undefined && <Text style={styles.cardTitle} accessibilityRole="header">{props.title}</Text>}
      {props.children}
    </View>
  );
}

/** Fila etiqueta / valor que se parte en dos líneas con fuente aumentada (flexWrap). */
export function Row(props: { label: string; value: string; testID?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{props.label}</Text>
      <Text style={styles.rowValue} testID={props.testID}>
        {props.value}
      </Text>
    </View>
  );
}

export function Pill(props: { text: string; tone: "ok" | "warn" | "danger" | "neutral"; testID?: string }) {
  const color = { ok: colors.ok, warn: colors.warn, danger: colors.danger, neutral: colors.textMuted }[props.tone];
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color }]} testID={props.testID}>
        {props.text}
      </Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  button: {
    minHeight: touch.primary,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonLabel: { fontSize: font.body + 2, fontWeight: "700", textAlign: "center" },
  card: {
    backgroundColor: colors.surfaceStrong,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardTitle: { fontSize: font.body + 2, fontWeight: "700", color: colors.text },
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: spacing.xs },
  rowLabel: { fontSize: font.small, color: colors.textMuted, flexShrink: 1 },
  rowValue: { fontSize: font.body, color: colors.text, fontWeight: "600", flexShrink: 1 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    minHeight: 32,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  pillText: { fontSize: font.small, fontWeight: "700", flexShrink: 1 },
  body: { fontSize: font.body, color: colors.text, lineHeight: 22 },
  muted: { fontSize: font.small, color: colors.textMuted, lineHeight: 20 },
});
