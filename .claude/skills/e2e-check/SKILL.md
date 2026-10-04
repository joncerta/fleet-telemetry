---
name: e2e-check
description: Verifica el pipeline completo de Fleet Telemetry de punta a punta en local (infra, ingesta con duplicados e inválidos, ACK, idempotencia, DLQ, estado, alertas, SSE, multi-tenant, agente IA, circuit breaker y tests). Úsala antes de cerrar una fase o antes de grabar el video.
argument-hint: "[video] [sin-breaker]"
context: fork
agent: qa-verifier
allowed-tools: Read, Grep, Glob, Bash
---
<!-- EDITA: puertos, nombres de servicios de docker compose, credenciales locales, tablas y endpoints según tu repo. -->

Argumentos: $ARGUMENTS
- `video`: agrega al final el chequeo de preparación para grabar.
- `sin-breaker`: omite el paso 10.

Estado de la infraestructura:
!`docker compose ps --format "table {{.Name}}\t{{.Status}}" 2>&1`

Commit: !`git rev-parse --short HEAD` · Cambios sin commitear: !`git status --short | wc -l`

## Preparación

- Lee `packages/contracts/src/telemetry.ts` y `packages/contracts/src/fleet.ts` para construir los payloads válidos y conocer la forma del ACK, el snapshot y los eventos SSE.
- Define un `RUN_ID` (por ejemplo, `e2e-<timestamp>`) y usa **vehículos propios de esta corrida**: `e2e-<RUN_ID>-v1`, `-v2`, etc. Todas las consultas filtran por esos vehículos y por un rango de tiempo reciente. Nunca cuentes sobre la tabla completa.
- **Identidad** (regla 4 de CLAUDE.md): el gateway toma el vehículo y el tenant del token de dispositivo; fleet-api y el agente toman el tenant de la sesión.
  - Por cada vehículo de prueba (`e2e-<RUN_ID>-v1`, `-v2`), crea el vehículo y su token de dispositivo en el tenant A con el comando local que documente `CLAUDE.md`. Los lotes de cada vehículo se envían con su token.
  - Inicia sesión con el usuario sembrado del tenant A y con el del tenant B, guarda cada cookie en un archivo (`-c <archivo>`) y úsala con `-b <archivo>` en las llamadas a `:4002` y `:4003`.
  - Si el comando de tokens o los usuarios sembrados no existen, los pasos que dependen de ellos son ❌, con el pendiente para `backend-engineer`.
- Escribe cada `curl` con la URL justo después de `-s` o `-sN` (`curl -s localhost:4002/...`) y los parámetros de consulta con `-G -d`, para que coincidan con los permisos de `settings.json` y no queden `&` sin comillas.
- Genera los `eventId` con UUIDs nuevos (`node -e "console.log(crypto.randomUUID())"`).
- Para esperar, haz **polling** cada 2 s hasta 60 s. Nada de `sleep` fijo. Si vence el timeout, el paso es ❌ con el último valor observado.
- Consultas SQL de referencia, con el usuario de **solo lectura** `fleet_ro` (lo crea una migración del backend; si no existe, repórtalo como pendiente para `backend-engineer` y no uses otro usuario):
  `docker compose exec -T timescaledb psql -U fleet_ro -d fleet -At -c "<consulta>"`
- Comandos de Redpanda con `docker compose exec -T redpanda rpk ...` (`topic list`, `topic describe`, `topic consume` con `timeout`).

## Verificaciones

**1. Infra**
- Redpanda y TimescaleDB en `healthy`. Si no, `docker compose up -d` y polling hasta `healthy`.
- Extensiones `timescaledb` y `postgis` instaladas. Existen los tópicos `telemetry.raw`, `telemetry.dlq`, `vehicle.state` y `fleet.alerts` (`rpk topic list`).
- No hay migraciones pendientes (según el comando de estado de `pnpm db:migrate`, si existe).

**2. Servicios**
- `curl -s localhost:4001/health`, `:4002/health` y `:4003/health` responden OK.
- Si no responden, **no los lances tú**: indica al humano que corra `pnpm dev`, marca los pasos dependientes como ⚠️ no verificado y continúa con lo que se pueda.

**3. Ingesta, ACK e idempotencia** (`POST :4001/v1/telemetry/batch`)

Lote A, para `e2e-<RUN_ID>-v1` y enviado con su token de dispositivo: 5 puntos válidos únicos, 1 punto duplicado (mismo `eventId` que uno de los 5) y 1 punto que no cumple el esquema. Coordenadas dentro de Colombia.
- Primer envío. Esperado (regla 7 de CLAUDE.md):
  - el ACK lista los 5 `eventId` válidos en `accepted`;
  - el punto inválido aparece en `rejected` con su motivo;
  - el duplicado dentro del lote no genera dos filas.
- Polling hasta que `select count(*) from telemetry where vehicle_id = 'e2e-<RUN_ID>-v1' and <columna de tiempo> > now() - interval '15 minutes'` llegue a **5**.
- Segundo envío del **mismo** lote A. Esperado:
  - el ACK vuelve a listar los 5 válidos en `accepted` (si no, el móvil los reintentaría para siempre);
  - el conteo **sigue en 5**.

**4. DLQ**
- **Inválido del gateway**: consume `telemetry.dlq` (`rpk topic consume telemetry.dlq -o start` con timeout) y busca **el `eventId` del punto inválido del lote A**. Esperado: está **una sola vez** (el segundo envío del lote no debe duplicarlo, o, si lo duplica, que se documente como decisión), con el motivo y el payload original. No vale cualquier mensaje viejo de la DLQ.
- **Envelope roto**: envía un cuerpo que no es JSON válido. Esperado: `400` y nada nuevo en la DLQ.
- **Inválido del processor**: envía 1 punto que pase el gateway pero falle al procesar, con el mecanismo que defina el backend. Esperado: llega a `telemetry.dlq` con su motivo tras los reintentos y no está en la tabla `telemetry`. Si el backend no ofrece cómo provocarlo, marca ⚠️ no verificado y anótalo como pendiente para `backend-engineer`.

**5. Datos geográficos**
- `select count(*) from telemetry where vehicle_id like 'e2e-<RUN_ID>-%' and not (ST_Y(<columna geo>::geometry) between -4.3 and 13.5 and ST_X(<columna geo>::geometry) between -79.1 and -66.8)` devuelve **0**. Si no, casi seguro hay coordenadas lon/lat invertidas en algún punto del pipeline.

**6. Estado y alertas**
- Siembra `e2e-<RUN_ID>-v2` detenido dentro de una zona crítica, con puntos que tengan timestamps de hace más de 2 minutos (así no hay que esperar). Si el backend calcula "detenido" con la hora de llegada y no con la del evento, anótalo como hallazgo.
- `curl -s localhost:4002/v1/vehicles/stopped -G -d minMinutes=1 -d zoneKind=critical -b <cookie-A>`. Esperado: incluye `e2e-<RUN_ID>-v2` y no incluye `e2e-<RUN_ID>-v1`.
- `curl -s localhost:4002/v1/alerts -b <cookie-A>`. Esperado: hay una alerta para `e2e-<RUN_ID>-v2`, y solo una.

**7. SSE**
- `timeout 5 curl -sN localhost:4002/v1/stream -b <cookie-A> | head -5`. Esperado: `event: snapshot`.
- Con el stream abierto (`timeout 20 curl -sN ... > /tmp/sse-<RUN_ID>.log &`), envía un punto nuevo de `e2e-<RUN_ID>-v1`. Esperado:
  - llega un evento con ese vehículo y con línea `id:`;
  - aparece al menos un heartbeat en el intervalo configurado.

**8. Multi-tenant**
- Con la cookie del tenant B, consulta vehículos y alertas, abre el SSE y pregunta al agente por `e2e-<RUN_ID>-v2`. Esperado: **ningún** dato de los vehículos del tenant A.
- Sin cookie, las mismas llamadas a `:4002` y `:4003` responden `401`.
- Este paso es obligatorio desde el cierre de la fase 1. Si la autenticación no existe o se filtra cualquier dato del tenant A, es ❌.

**9. Agente IA** (`POST :4003/v1/agent/chat`)
- Pregunta: "¿Qué vehículos llevan detenidos más de 1 minuto en zonas críticas?". Esperado:
  - `toolCalls` incluye `get_stopped_vehicles`;
  - la respuesta menciona `e2e-<RUN_ID>-v2`.
- El LLM no es determinista: si falla, reintenta una vez. Si pasa en el segundo intento, es ⚠️ flaky.

**10. Circuit breaker** (omitir con `sin-breaker`)
- Detén fleet-api (`docker compose stop <servicio>`; si corre con `pnpm dev`, pide al humano que lo detenga).
- Haz al agente tantas preguntas como el umbral configurado en opossum (léelo del código; no asumas 6). Esperado:
  - `dependencies.fleetApi = "open"` en `:4003/health`;
  - el agente responde que el dato **no está disponible**, sin inventar vehículos;
  - ninguna llamada se queda colgada más allá del timeout configurado.
- **Restaura fleet-api** y haz polling hasta que el breaker vuelva a `closed` y una pregunta funcione de nuevo. Si no se recupera, es ❌.

**11. Suites automatizadas**
- `pnpm turbo run typecheck test`. Esperado: sin fallos.
- `pnpm test:integration`. Esperado: sin fallos.
- `pnpm test:e2e` (backend) y Playwright de la web, si ya existe. Esperado: sin fallos, sin tests saltados.
- Cada flujo verificado a mano en esta skill tiene su test e2e automatizado. Si alguno no lo tiene, es ❌: anótalo como pendiente para el agente del área.

## Preparación para grabar (solo con `video`)

- Todos los pasos anteriores en ✅, salvo ⚠️ manuales con instrucciones.
- Datos de demo sembrados (no solo los `e2e-*`): vehículos visibles moviéndose en el mapa.
- Nada sensible visible: `.env`, tokens en la terminal, llaves de API.
- Sin reinicios recientes en `docker compose ps`.

## Reporte

Usa el formato de `qa-verifier`:
- encabezado con entorno, `RUN_ID`, conteo de ✅/❌/⚠️ y veredicto `LISTO` / `NO LISTO`;
- una entrada por verificación con comando, esperado y real.

Los pasos 3, 4, 8 y 10 son críticos: un ❌ o un ⚠️ no verificado en cualquiera de ellos da `NO LISTO`. En los pasos 3, 4 y 10 se admite un ⚠️ solo si la funcionalidad todavía no existe en esta fase y así lo dice CLAUDE.md. El paso 8 (multi-tenant) no tiene esa excepción.

No corrijas nada. Si algo falla, reporta los logs relevantes (`docker compose logs --tail=50 <servicio>`), la causa probable, el archivo sospechoso y qué agente debería corregirlo.
