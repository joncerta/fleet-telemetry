# @fleet/simulator

Simulador de vehículos para la demo y para validar el dashboard: `pnpm simulate`. Solo local.

## Qué hace

- 30 vehículos: los 15 sembrados de Flota Norte (Bogotá) y de Flota Sur (Medellín), con rutas por calles en damero dentro de cada ciudad.
- Por tenant: 2 se detienen en una zona crítica sembrada (al arrancar envían el historial de la parada, de 25 a 30 minutos atrás, y siguen enviando puntos detenidos), 1 envía `mocked: true`, 1 deja de enviar a los 60 s (aparece "sin señal" a los 5 minutos) y el resto se mueve.
- Un punto cada 5 s por vehículo y un lote por vehículo cada 10 a 15 s a `POST /v1/telemetry/batches`. El ACK se lee con el esquema tolerante; un fallo transitorio reintenta con los mismos `eventId`.
- Logs: solo conteos por tenant (enviados, aceptados, rechazados, lotes fallidos y latencia del ACK). Sin coordenadas, placas ni tokens.

## Requisitos

1. `docker compose up -d --wait` y `pnpm db:migrate && pnpm db:seed` (una vez).
2. Gateway y processor arriba (`pnpm dev`). Para ver "detenidos" y alertas en el dashboard, también `fleet-api`.

## Uso

```
pnpm simulate                                   # hasta Ctrl+C
SIMULATOR_DURATION_S=120 pnpm simulate          # se apaga solo a los 2 minutos
SIMULATOR_GATEWAY_URL=http://127.0.0.1:4101 pnpm simulate
```

Variables (todas opcionales, documentadas en `.env.example`): `SIMULATOR_GATEWAY_URL`, `SIMULATOR_VEHICLES_PER_TENANT` (4 a 15),
`SIMULATOR_POINT_INTERVAL_MS`, `SIMULATOR_BATCH_MIN_MS`, `SIMULATOR_BATCH_MAX_MS`, `SIMULATOR_SEED`, `SIMULATOR_DURATION_S`,
`SIMULATOR_SILENT_AFTER_S`, `SIMULATOR_STATS_INTERVAL_S`.

## Tiempos de la demo

| Desde que arranca | Qué se ve |
| --- | --- |
| ~5 s | historial enviado: los 30 vehículos con estado y 4 detenidos con 25 a 30 minutos |
| ~15 s | `critical_zone_stop` (2 por tenant) y `mocked_location` (1 por tenant) activas; `GET /v1/vehicles/stopped?minMinutes=20&zoneKind=critical` responde 2 por tenant |
| 60 s | el vehículo silencioso envía su último punto |
| ~6 min | ese vehículo aparece "sin señal" (5 minutos sin puntos, derivado por `fleet-api`) |

## Tokens

Los tokens de dispositivo se emiten al arrancar con `issueDeviceToken` de `@fleet/dev-data`, con sus mismas guardas de base local (host de
la allowlist y marca `fleet.environment=local`), y viven solo en memoria. **Emitir rota**: revoca el token activo de esos 30 vehículos
(por ejemplo, uno emitido antes con `pnpm device:token`). El gateway tarda hasta `INGEST_GATEWAY_TOKEN_CACHE_TTL_MS` (30 s) en dejar de
aceptar el anterior.

## Límites conocidos

- Las rutas no usan datos reales de calles: es un damero de 120 m alineado con los ejes.
- Reiniciar el simulador vuelve a enviar el historial de la parada, con `recordedAt` relativos al nuevo arranque; el estado no retrocede (el processor ignora lo anterior al estado vigente).
- Los puntos que ya están generados pero no enviados cuando se pulsa Ctrl+C se descartan.
- Tests: `pnpm --filter @fleet/simulator test` (unitarios) y `pnpm --filter @fleet/simulator test:integration` (tokens contra la base real).
