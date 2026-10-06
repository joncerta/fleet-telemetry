import type {
  Alert,
  Session,
  SseAlertTolerant,
  SseSnapshotTolerant,
  SseVehicleStateTolerant,
  UserListItem,
  VehicleCatalogItem,
  VehicleState,
  ZoneCreateRequest,
  ZoneFeature,
  ZoneFeatureCollection,
  ZoneKind,
} from "@fleet/contracts";
import type { AuthIdentity } from "../domain/identity.js";
import type { ZoneRef } from "../domain/fleet-status.js";
import type { FleetStreamEvent } from "../domain/stream-ordering.js";

/** Puertos de fleet-api: lo que sus casos de uso necesitan del mundo exterior. */

/** Reloj del servidor. Un puerto, para que los casos de uso no dependan de la hora real en los tests. */
export interface Clock {
  now(): Date;
}

/** Una dependencia cuyo estado informa `GET /health`. La implementación decide qué significa "responde". */
export interface ReadinessCheck {
  /** Clave en `checks` de la respuesta (`database`...). */
  readonly name: string;
  /**
   * `true` si la dependencia responde. No lanza: un fallo (o un tiempo agotado) es `false`, y el detalle va al log
   * del adaptador, nunca a la respuesta.
   */
  check(): Promise<boolean>;
}

// --- Sesión ---

/** Cuenta de un usuario para el login. `passwordHash` es el de `hashPassword`; nunca sale de la capa de aplicación. */
export interface UserAccount extends AuthIdentity {
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly tenantName: string;
}

export interface UserRepository {
  /** El usuario con ese correo, SIN distinguir mayúsculas, o `null`. Un fallo de la base se propaga (no se confunde con "no existe"). */
  findByEmail(email: string): Promise<UserAccount | null>;
  /** Datos de sesión de una identidad ya verificada, o `null` si el usuario ya no existe en ese tenant. */
  findProfile(identity: AuthIdentity): Promise<Session | null>;
}

/** Compara una contraseña con su hash en tiempo constante. `false` ante cualquier hash inválido; nunca lanza por eso. */
export interface PasswordVerifier {
  verify(password: string, passwordHash: string): Promise<boolean>;
}

// --- Lecturas del read model (todas filtran por `tenantId`) ---

export interface VehicleStatusCounts {
  readonly moving: number;
  readonly stopped: number;
  readonly noSignal: number;
}

export interface SummaryReader {
  /**
   * Vehículos del tenant por estado. Un vehículo con `received_at` ANTERIOR a `noSignalBefore`, o que nunca reportó (sin fila de
   * estado), cuenta en `noSignal`; el resto, en su `movement`. Los tres conteos suman los vehículos del tenant.
   */
  countVehicleStatus(tenantId: string, noSignalBefore: Date): Promise<VehicleStatusCounts>;
  /** Alertas activas (sin `resolvedAt`) del tenant. */
  countActiveAlerts(tenantId: string): Promise<number>;
}

export interface StoppedVehicleRow {
  readonly vehicleId: string;
  readonly plate: string;
  readonly stoppedSince: Date;
  readonly lon: number;
  readonly lat: number;
  /** Zonas que contienen la posición (las del tipo pedido, si se filtró). */
  readonly zones: readonly ZoneRef[];
}

export interface StoppedVehicleQuery {
  readonly tenantId: string;
  /** Solo detenidos con `stoppedSince` IGUAL O ANTERIOR a este instante. */
  readonly stoppedAtOrBefore: Date;
  /** Solo vehículos con señal: `receivedAt` IGUAL O POSTERIOR a este instante. */
  readonly signalSince: Date;
  readonly zoneKind: ZoneKind | undefined;
  readonly limit: number;
}

export interface StoppedVehicleReader {
  /** Detenidos con señal, los que llevan más tiempo primero (`stoppedSince` ascendente, `vehicleId` desempata). A lo sumo `limit`. */
  findStopped(query: StoppedVehicleQuery): Promise<StoppedVehicleRow[]>;
}

/** Posición de un keyset de alertas: `raisedAt` con la precisión de la base (microsegundos, ISO UTC) y el `alertId`. */
export interface AlertCursor {
  readonly raisedAt: string;
  readonly alertId: string;
}

export interface AlertRecord {
  readonly alert: Alert;
  /** Posición de ESTA alerta, para continuar después de ella. */
  readonly cursor: AlertCursor;
}

export interface AlertQuery {
  readonly tenantId: string;
  readonly status: "active" | "all";
  /** Solo alertas ESTRICTAMENTE después de esta posición en el orden (`raisedAt` desc, `alertId` desc). */
  readonly after: AlertCursor | undefined;
  readonly limit: number;
}

export interface AlertReader {
  /** De la más reciente a la más antigua, a lo sumo `limit`; la placa y el nombre de la zona salen de un JOIN. */
  findAlerts(query: AlertQuery): Promise<AlertRecord[]>;
}

export interface ZoneReader {
  /** Zonas del tenant como `FeatureCollection` de GeoJSON, coordenadas `[lng, lat]`. Acotado por un tope. */
  findZones(tenantId: string): Promise<ZoneFeatureCollection>;
}

export type CreateZoneResult =
  | { readonly status: "created"; readonly zone: ZoneFeature }
  | { readonly status: "name_taken" }
  | { readonly status: "invalid_geometry" };

export interface ZoneRepository {
  /**
   * Inserta la zona en el tenant. `name_taken` si el nombre ya existe en ESE tenant; `invalid_geometry` si PostGIS considera inválido el
   * polígono (auto-intersección). Cualquier otro fallo de la base se propaga. Devuelve el Feature con el mismo formato que `findZones`.
   */
  create(input: { tenantId: string; zoneId: string; name: string; kind: ZoneCreateRequest["kind"]; geometry: ZoneCreateRequest["geometry"] }): Promise<CreateZoneResult>;
}

// --- Catálogo de vehículos y usuarios del tenant (todo filtra por `tenantId`) ---

export type CreateVehicleResult =
  | { readonly status: "created"; readonly vehicle: VehicleCatalogItem }
  | { readonly status: "plate_taken" };

export interface VehicleCatalogRepository {
  /** Vehículos del tenant ordenados por placa (`id` desempata), a lo sumo `limit`. `hasActiveDevice`: tiene un dispositivo sin revocar. */
  list(tenantId: string, limit: number): Promise<VehicleCatalogItem[]>;
  /**
   * Inserta el vehículo en el tenant. `plate_taken` si la placa ya existe en ESE tenant (la unicidad es por tenant). Un fallo de la base
   * se propaga. El vehículo nuevo no tiene dispositivo (`hasActiveDevice: false`).
   */
  create(input: { tenantId: string; vehicleId: string; plate: string; label: string | null }): Promise<CreateVehicleResult>;
}

export interface TenantUserReader {
  /** Usuarios del tenant ordenados por nombre (`userId` desempata), a lo sumo `limit`. Nunca devuelve el hash de la contraseña. */
  listUsers(tenantId: string, limit: number): Promise<UserListItem[]>;
}

// --- Vinculación de dispositivos ---

/** Genera los secretos de la vinculación con un generador criptográfico. Un puerto: el dominio y los tests no dependen de la entropía. */
export interface PairingCredentials {
  /** Código de `PAIRING_CODE_LENGTH` caracteres de `PAIRING_CODE_ALPHABET`. */
  newPairingCode(): string;
  /** Token de dispositivo con el formato de `deviceTokenSchema` (`fdt_` + 43 caracteres). */
  newDeviceToken(): string;
  newDeviceId(): string;
}

export type CreatePairingCodeResult =
  | { readonly status: "created"; readonly expiresAt: Date }
  | { readonly status: "vehicle_not_found" }
  | { readonly status: "code_collision" };

export interface PairingCodeRepository {
  /**
   * Guarda el HASH de un código nuevo para un vehículo del tenant, con vencimiento `ttlMinutes` desde ahora (reloj de la base).
   * `vehicle_not_found` si el vehículo no es del tenant (nunca revela si existe en otro); `code_collision` si ese hash ya existe.
   */
  create(input: { tenantId: string; vehicleId: string; createdBy: string; codeHash: string; ttlMinutes: number }): Promise<CreatePairingCodeResult>;
}

/** Operaciones del canje, todas dentro de UNA transacción. */
export interface PairingTransaction {
  /** Marca el código como usado SI sigue vigente (no usado, no vencido) y devuelve su vehículo; `null` si no. Atómico. */
  consumeCode(codeHash: string): Promise<{ tenantId: string; vehicleId: string } | null>;
  /** Bloquea la fila del vehículo (serializa vinculaciones simultáneas del mismo vehículo) y devuelve su placa. */
  lockVehicle(tenantId: string, vehicleId: string): Promise<{ plate: string } | null>;
  /** Revoca el dispositivo activo del vehículo, si lo hay. */
  revokeActiveDevices(tenantId: string, vehicleId: string): Promise<void>;
  /** Crea el dispositivo con el HASH de su token. Devuelve la hora del servidor de la vinculación. */
  insertDevice(input: { deviceId: string; tenantId: string; vehicleId: string; tokenHash: string }): Promise<{ createdAt: Date }>;
}

export interface PairingUnitOfWork {
  /** Corre `work` en una transacción: la confirma si resuelve y la revierte si lanza. */
  run<T>(work: (transaction: PairingTransaction) => Promise<T>): Promise<T>;
}

// --- Stream SSE ---

/** Estado de la flota de UN tenant, leído en una sola transacción (ver `FleetSnapshotReader`). */
export interface FleetSnapshotData {
  /** Último estado de cada vehículo con estado. */
  readonly vehicles: readonly VehicleState[];
  /** Alertas ACTIVAS (sin `resolvedAt`). */
  readonly alerts: readonly Alert[];
}

export interface FleetSnapshotReader {
  /**
   * Vehículos y alertas activas del tenant, ambos de UNA transacción (`REPEATABLE READ`): una misma vista consistente de las dos tablas,
   * de la que sale el `cursor`. Un tenant demasiado grande para un snapshot es un error (nunca se trunca en silencio).
   */
  read(tenantId: string): Promise<FleetSnapshotData>;
}

/** Suscripción a los cambios de la flota de un tenant (los que llegan por Kafka). */
export interface FleetEventSubscriptions {
  /** Entrega a `listener` cada evento del tenant desde ahora. Devuelve la función que cancela la suscripción (idempotente). */
  readonly subscribe: (tenantId: string, listener: (event: FleetStreamEvent) => void) => () => void;
}

/** Un mensaje del stream: el `event:` y el `id:` de SSE, y su dato (esquemas `Sse*` del contrato). */
export type FleetStreamMessage =
  | { readonly event: "snapshot"; readonly id: string; readonly data: SseSnapshotTolerant }
  | { readonly event: "vehicle.state"; readonly id: string; readonly data: SseVehicleStateTolerant }
  | { readonly event: "alert"; readonly id: string; readonly data: SseAlertTolerant };

/** La conexión de un cliente, vista por el caso de uso. La implementa la entrada HTTP sobre el socket. */
export interface FleetStreamSink {
  /** Escribe el mensaje en la conexión. Puede lanzar si la conexión ya se cerró. */
  deliver(message: FleetStreamMessage): void;
  /** Bytes escritos que el cliente todavía no ha leído (el buffer del socket): lo que mide a un cliente lento. */
  pendingBytes(): number;
  /** Corta la conexión del lado del servidor. Idempotente. */
  end(): void;
  /** Registra lo que debe pasar cuando la conexión se cierra (por el cliente o por `end`). */
  onClose(listener: () => void): void;
}
