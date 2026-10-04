# 00 · Base común (aplica a las 3 opciones)

Lo que está aquí **no cambia** con la opción que elijamos: requisitos, contratos, y las
decisiones de S4 (web) y S5 (móvil) que impone el stack fijado.

## 1. Requisitos de la prueba → trazabilidad

| Req. | Enunciado (resumen) | Dónde se cubre |
|---|---|---|
| A1 | Ingesta asíncrona por bus de eventos (Kafka/RabbitMQ) | Ingest API → topic `telemetry.raw.v1` |
| A2 | Persistencia especializada y justificada (series de tiempo) | Ver cada opción (Timescale / Cassandra) |
| A3 | Circuit breakers entre microservicios | Ingest→bus, Processor→DB, Agente→LLM, BFF→servicios |
| B  | Agente IA que consulta estado actual en lenguaje natural | Servicio de agente con *tools* tipadas |
| C  | SPA con WebSockets/SSE: mapa, alertas en vivo, chat IA | **S4** (Next.js + MapLibre + SSE) |
| D1 | App offline-first, SQLite, sync en bloque al reconectar | **S5** (Expo + expo-sqlite outbox) |
| D2 | CI/CD móvil (Fastlane, GitHub Actions) | **S5** (GH Actions + EAS + Fastlane) |
| E1 | k6/JMeter: cientos de vehículos, 10 % duplicados, 5 % errores | `load/k6/` |
| E2 | IaC (Terraform/CDK) + Docker Compose local | `infra/` |
| 7  | README, **Auditoría de IA** (≥2 casos), video 5–10 min | `README.md`, `docs/ai-audit.md` |

Criterios de evaluación a los que optimizamos: **arquitectura agéntica auditada**,
**uso correcto de eventos + justificación de BD**, **offline-first sólido + CI/CD**.

## 2. Estructura del monorepo (pnpm workspaces + Turborepo)

```
fleet-telemetry/
├─ apps/
│  ├─ web/            # S4 · Next.js App Router
│  │  └─ design/      # ← este diseño
│  └─ mobile/         # S5 · Expo (dev build Android)
├─ services/          # backend (lenguaje según opción)
├─ packages/
│  └─ contracts/      # @fleet/contracts · zod → tipos TS + JSON Schema
├─ infra/             # docker-compose.yml, terraform/
├─ load/k6/           # carga + caos
├─ docs/              # ADRs, ai-audit.md
└─ .github/workflows/
```

## 3. `@fleet/contracts` (fuente única de verdad)

Zod v4 → `z.infer` para TS (web, móvil, servicios TS) y `z.toJSONSchema()` exportado a
`packages/contracts/schemas/*.json` para servicios no-TS. Fixtures *golden* en
`packages/contracts/fixtures/` que todos los lados validan en sus tests (contract tests).

```ts
// Ingesta (móvil → backend)
TelemetryPoint = {
  eventId: uuidv7,          // idempotencia por punto (generado en el dispositivo)
  vehicleId: string, deviceId: string,
  seq: int,                 // monotónico por dispositivo (detecta huecos)
  recordedAt: ISO-8601,     // event-time (NO processing-time)
  lat: [-90,90], lng: [-180,180],
  speedKmh?: number, headingDeg?: number, accuracyM?: number, batteryPct?: number
}
TelemetryBatch = { batchId: uuidv7, deviceId, sentAt: ISO, points: TelemetryPoint[1..500] }
BatchAck       = { batchId, accepted: eventId[], rejected: { eventId, reason }[] }

// Lectura (backend → web)
VehicleStatus  = 'moving' | 'idle' | 'stopped' | 'offline'
VehicleState   = { vehicleId, lat, lng, speedKmh, headingDeg, status,
                   stoppedSince?: ISO, zoneIds: string[], lastSeenAt: ISO, version: int }
Alert          = { alertId, vehicleId, type: 'PROLONGED_STOP_CRITICAL_ZONE'|'OFFLINE'|'SPEEDING',
                   severity: 'info'|'warning'|'critical', zoneId?, startedAt, raisedAt, resolvedAt? }
Zone           = { zoneId, name, criticality: 'normal'|'critical', polygon: GeoJSON.Polygon }

// SSE (un único stream multiplexado)
SseEvent = | { type: 'snapshot',      data: { vehicles: VehicleState[], alerts: Alert[] } }
           | { type: 'vehicle.state', data: VehicleState }
           | { type: 'alert.raised',  data: Alert }
           | { type: 'alert.resolved',data: Alert }
           | { type: 'heartbeat',     data: { ts } }

// Chat agente (POST con respuesta en stream)
AgentChatRequest = { conversationId, message }
AgentChatChunk   = | { kind: 'token', text } | { kind: 'tool', name, status }
                   | { kind: 'refs', vehicleIds: string[] } | { kind: 'done' } | { kind: 'error', message }
```

Reglas: versionado en el nombre del topic/ruta (`.v1`, `/v1`); campos solo se **añaden**;
`version` en `VehicleState` es monotónico → el cliente descarta updates más viejos.

## 4. S4 · Web — decisiones invariantes

| Tema | Decisión | Por qué |
|---|---|---|
| Render inicial | RSC pide `GET /v1/fleet/snapshot` y lo pasa a `<FleetProvider initial>` | Primer pintado con datos, sin “mapa vacío” |
| Tiempo real | **1** `EventSource` por pestaña, eventos multiplexados | Límite de 6 conexiones HTTP/1.1 por origen |
| Reanudación | `id:` en cada evento + `Last-Event-ID`; si el gap es grande, el server reenvía `snapshot` | Reconexión sin pérdidas |
| Vigilancia | Sin `heartbeat` en 30 s → cerrar y reconectar con backoff; badge de conexión | `EventSource` no detecta conexiones zombis |
| Validación | `SseEvent.safeParse` de `@fleet/contracts`; inválidos se descartan y se cuentan | El front no confía en el wire |
| Estado | Store con `vehicles: Map`, `alerts: Map`, `connection`, `selectedId`; regla `version` | Idempotente ante duplicados/desorden |
| Rendimiento | Buffer de eventos → *flush* con `requestAnimationFrame` (≤ 4 Hz) | 1 000 vehículos × 1 evt/5 s = 200 evt/s |
| Mapa | MapLibre con **una** fuente GeoJSON + `circle`/`symbol` layers, `setData()` fuera de React | Nada de un `<Marker>` React por vehículo |
| Basemap | OpenFreeMap `liberty` (sin token); fallback CARTO Positron | Gratis, sin API key |
| SSR | `maplibre-gl` vía `next/dynamic({ ssr:false })` dentro de componente cliente | Usa `window` |
| Zonas | Capa `fill` con zonas críticas (rojo translúcido) | Contexto visual de la alerta |
| Chat | `fetch` POST + `ReadableStream` (no `EventSource`, que solo hace GET) | Muestra tokens, tools en curso y `refs` clicables → centra el mapa |
| A11y | Lista de alertas con `aria-live="polite"`, color + icono | No depender solo del color |
| Tests | Vitest (reducers del store, parser SSE), Playwright con servidor SSE mock | Determinista, sin backend |

Layout del dashboard:

```
┌───────────────────────────────────────────────────────────────────┐
│ FleetView   ● En vivo   Online 312 · Mov 240 · Det 58 · Alertas 7 │
├─────────────────────────────────────────────┬─────────────────────┤
│                                             │ [Alertas] [Chat IA] │
│                 MAPA (MapLibre)             │ ▲ CRIT  V-102 det.  │
│   ● moving  ● idle  ● stopped  ○ offline    │   27 min · Zona Pto │
│   ▒▒ zonas críticas                         │ ▲ WARN  V-077 offln │
│                                             │ ...                 │
├─────────────────────────────────────────────┴─────────────────────┤
│ Drawer vehículo seleccionado: velocidad, estado, últ. señal, track│
└───────────────────────────────────────────────────────────────────┘
```

Rutas: `/dashboard` (mapa+alertas+chat), `/vehicles/[id]` (detalle + track histórico vía REST),
`/alerts` (historial).

## 5. S5 · Móvil — decisiones invariantes

**Patrón Outbox transaccional**: la captura GPS **solo escribe en SQLite**; un *SyncEngine*
independiente vacía la cola. Nunca se hace red desde el callback de ubicación.

```
expo-location (task en 2º plano, foreground service Android)
        │  INSERT (1 transacción por lote de ubicaciones)
        ▼
   SQLite outbox  ──►  SyncEngine  ──►  POST /v1/telemetry/batch  (Idempotency-Key: batchId)
        ▲                 ▲  disparadores: NetInfo reconecta · intervalo 30 s en foreground ·
        │                 │                tras escribir en el task si hay red · app vuelve a foreground
        └── ack: DELETE accepted · rejected → dead_letter · 5xx/timeout → pending + backoff
```

```sql
CREATE TABLE outbox (
  event_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, recorded_at TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, speed_kmh REAL, heading_deg REAL, accuracy_m REAL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | inflight
  batch_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX outbox_status_seq ON outbox(status, seq);
CREATE TABLE dead_letter (event_id TEXT PRIMARY KEY, reason TEXT, payload TEXT, created_at TEXT);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);   -- next_seq, device_id, last_sync_at
PRAGMA journal_mode = WAL;
```

Algoritmo de sync (at-least-once en cliente + dedupe por `eventId` en servidor = efecto *exactly-once*):

1. Al arrancar: `UPDATE outbox SET status='pending' WHERE status='inflight'` (recuperación de crash).
2. Lock en memoria (un solo flush a la vez). Si no hay red → salir.
3. Reclamar hasta 500 puntos `ORDER BY seq` → `status='inflight', batch_id=uuidv7()` (transacción).
4. POST con timeout 15 s. `2xx` → borrar `accepted`, mover `rejected` a `dead_letter`.
   `429` → respetar `Retry-After`. `5xx`/timeout/`503` (breaker abierto) → volver a `pending`,
   `attempts++`, backoff exponencial con jitter (1 s → 5 min).
5. Si quedan pendientes y fue OK → repetir inmediatamente (vaciado en bloque al reconectar).
6. Tope de cola 50 000 filas: si se excede, *thinning* de lo más antiguo (1 de cada N), nunca bloquear captura.

Detalles Android/Expo: development build obligatorio (Expo Go no soporta ubicación en 2º plano en
Android); plugin `expo-location` con `isAndroidBackgroundLocationEnabled` e
`isAndroidForegroundServiceEnabled`; permisos foreground → background en dos pasos con pantalla
explicativa; `TaskManager.defineTask` en el *entry* (`index.ts` importa el task antes de
`expo-router/entry`); muestreo adaptativo (`timeInterval` 5 s / `distanceInterval` 10 m en
movimiento, más laxo detenido); token del dispositivo en `expo-secure-store`;
NetInfo como **pista** (`isConnected && isInternetReachable !== false`), nunca como verdad —
el fallo de red real también re-encola.

Capas (Clean Architecture): `domain/` (TelemetryPoint, reglas) · `application/`
(TrackingService, SyncEngine — dependen de puertos) · `infrastructure/` (ExpoLocationSource,
SqliteOutboxRepository, HttpTelemetryTransport, NetInfoConnectivity) · `ui/`. El SyncEngine se
prueba con Jest usando repositorio en memoria + transporte falso (pérdida de red, 5xx, 429, crash
a mitad de lote).

Pantallas: Emparejar vehículo → Turno (iniciar/detener tracking) con estado: puntos en cola,
último sync, conectividad, GPS → Debug (forzar offline, vaciar cola, ver dead letters).

## 6. Auditoría de IA — candidatos a documentar (registrar los reales durante el desarrollo)

1. Agente con tool `run_sql(query)` libre → inyección / DoS → *tools* tipadas, rol read-only, `statement_timeout`.
2. Envío de cada punto GPS con `fetch` desde el background task, sin cola → pérdida offline → outbox SQLite.
3. Un `<Marker>` React por vehículo + `setState` por evento SSE → tormenta de renders → GeoJSON + rAF.
4. *Auto-commit* de offsets Kafka antes de persistir → pérdida de datos → commit manual tras escribir.
5. Cola en AsyncStorage → sin transacciones ni consultas → SQLite con WAL.
