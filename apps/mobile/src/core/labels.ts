import type { ConnectionState, SyncSummary } from "./diagnostics";
import type { TrackingState } from "./tracking-state";

export const TRACKING_LABEL: Record<TrackingState, string> = {
  active: "Tracking activo",
  paused: "Tracking pausado",
  no_permission: "Sin permiso de ubicación",
  no_signal: "Sin señal de GPS",
};

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  online: "Con conexión",
  offline: "Sin conexión",
  unknown: "Conexión desconocida",
};

export const SYNC_LABEL: Record<SyncSummary, string> = {
  idle: "Sin datos por enviar",
  synced: "Todo enviado",
  pending: "Enviando",
  backoff: "Reintentando pronto",
  paused: "Envío detenido",
};

const REJECT_REASON_LABEL: Record<string, string> = {
  invalid_schema: "Formato inválido",
  vehicle_mismatch: "Vehículo no coincide con el token",
  future_timestamp: "Hora en el futuro",
  stale_timestamp: "Punto demasiado viejo",
  unknown: "Motivo desconocido",
};

export function rejectReasonLabel(reason: string): string {
  return REJECT_REASON_LABEL[reason] ?? reason;
}

/** Códigos que guarda el motor (sin datos personales) a texto para el conductor. */
export function errorLabel(code: string | null): string {
  if (code === null) return "Ninguno";
  if (code === "network") return "Sin red";
  if (code === "timeout") return "Tiempo de espera agotado";
  if (code === "ack_invalid") return "Respuesta del servidor inválida";
  if (code === "ack_incomplete") return "El servidor no confirmó todos los puntos";
  if (code === "http_401" || code === "http_403") return "Dispositivo no vinculado o token revocado";
  if (code === "http_429") return "Demasiadas solicitudes (429)";
  if (code === "http_400") return "Lote rechazado por el servidor (400)";
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return `Error del servidor (${http[1]})`;
  return code;
}

export function pausedLabel(reason: string | null): string | null {
  if (reason === null) return null;
  return reason === "unlinked" ? "Dispositivo no vinculado" : "Dispositivo no vinculado o token revocado";
}
