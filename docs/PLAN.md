# Plan por fases

Plan aprobado el 2026-10-04 para el MVP de monitoreo de flotas (prueba técnica "Senior Fullstack — Telemetría y Desarrollo Agéntico Extremo"). La prueba evalúa **el cómo**: decisiones de arquitectura, auditoría y corrección de la IA, e infraestructura.

- **Estado del avance:** `docs/PROGRESS.md`, que se actualiza con `/session-handoff`.
- **Reglas que mandan sobre este plan:** [`CLAUDE.md`](../CLAUDE.md) y los de cada área.
- **Cambios a este plan:** se proponen y los aprueba el humano.

## Cómo se trabaja

**Ramas**
- `master` guarda lo entregado. Solo recibe `develop` al cerrar una fase con `/e2e-check` en `LISTO`. La fase 0 no puede dar `LISTO` porque todavía no hay servicios, así que el primer paso de `develop` a `master` ocurre al cerrar la fase 1.
- `develop` es la rama de integración. Cada cambio sale en una rama propia desde `develop` (`feat/*`, `fix/*`, `chore/*`, `docs/*`, `ci/*`) y vuelve por PR.

**Roles**
- El orquestador coordina, revisa los resúmenes de los subagentes y redacta la documentación. El código lo escriben los subagentes.
- `/session-start`, `/session-handoff` y `/ai-audit-entry` solo las invoca el humano. El orquestador las propone en el momento justo.

**Ciclo de cada fase**
1. Plan de la fase, en 6 pasos como máximo, con el agente o la skill de cada paso. Se espera la aprobación del humano.
2. Rama nueva desde `develop`.
3. Contratos primero, con `/add-contract`. Después, productores y consumidores.
4. Implementación con el subagente del área. Los casos de uso del backend van con `/new-usecase`.
5. Tests por niveles (regla 17): unitarios, integración y e2e. Sin el stack arriba, la fase no está terminada.
6. Revisión: `/arch-review` para back, infra o contratos; `/front-review` para web o móvil. Los hallazgos críticos o altos vuelven al subagente y se revisa de nuevo.
7. Cada hallazgo marcado "¿Candidato a auditoría IA?: sí" se propone como `/ai-audit-entry <título>` en ese momento.
8. Se proponen commits con Conventional Commits, uno por cambio lógico. No se hace commit sin pedido del humano.
9. Al cerrar la fase, o si el contexto se llena, se propone `/session-handoff`.

**Paralelismo**

`0 → 1a → 1b → 1c → 1d → {2a → 2b ∥ 3 ∥ 4a} → 4b → 5 → 6`

## Trazabilidad de requisitos

| ID | Requisito | Fase | Evidencia esperada |
|---|---|---|---|
| A1 | Ingesta asíncrona por bus de eventos | 1a | gateway → Redpanda → processor, con tests |
| A2 | Persistencia de alta frecuencia justificada | 1b, 1d | TimescaleDB + PostGIS; ADR-002 frente a Cassandra y por qué no Druid |
| A3 | Circuit breakers entre microservicios | 1c | opossum de agent a fleet-api; test y demo del breaker abierto |
| B1 | Agente en lenguaje natural | 1c | LangChain con herramientas tipadas; responde "¿Qué vehículos llevan detenidos más de 20 minutos en zonas críticas?" |
| C1 | Dashboard reactivo por SSE | 2a, 2b | `apps/web`: mapa, alertas en vivo y chat |
| D1 | App móvil offline-first | 3 | `apps/mobile`: SQLite, sync en bloque, demo modo avión → reconexión |
| D2 | CI/CD móvil | 4b | GitHub Actions + EAS + Fastlane, sin publicar |
| E1 | Caos y carga | 4a | k6 con 10% de duplicados y 5% de inválidos, verificación por conteos |
| E2 | IaC y Docker Compose | 0, 4a, 4b | Terraform (`fmt` y `validate`) y `docker compose --profile app up -d --wait` |
| R1 | Commits estructurados | todas | Conventional Commits, uno por cambio lógico |
| R2 | README con ejecución e IaC | 6 | `README.md` |
| R3 | Auditoría de IA en el README | todas, 6 | Casos reales de `docs/AI_AUDIT_LOG.md` (mínimo 2) |
| R4 | Video de 5 a 10 min | 6 | `docs/VIDEO.md` y `/e2e-check video` en `LISTO` |

## Fase 0 — Entorno agéntico y esqueleto

**Ya hecho** en `chore/agentic-env`, sin push todavía:
- Commit del entorno agéntico original (`259da9c`) y un commit por cada arreglo:
  - `/front-review` registrada y frontmatter de `/add-contract` reparado;
  - hook de typecheck y tests en `Stop` y `SubagentStop`;
  - permisos cerrados;
  - flujo de ramas;
  - snapshot dentro del stream;
  - paso 8 de `/e2e-check` obligatorio.
- `.gitignore` para un repo público.
- Export de Claude Design en `apps/web/design/`.

**Pendiente**

| Paso | Quién | Entregable |
|---|---|---|
| 1 | Humano | Abrir Claude Code en `fleet-telemetry/` (ahí se activan el hook y los permisos), hacer push y PR de `chore/agentic-env` a `develop`, y lanzar `/session-start fase 0` |
| 2 | `devops-engineer` | `docker-compose.yml` de infraestructura con healthchecks, servicios `timescaledb` y `redpanda`, y creación de tópicos; `infra/CLAUDE.md` con la opción de Timescale en AWS y el modelo de k6; `ci.yml` mínimo (typecheck, lint, test) |
| 3 | `backend-engineer` | pnpm + Turborepo + tsconfig + Vitest + ESLint; `packages/platform` (config zod, logger, fábricas de Kafka y pg); `packages/contracts` vacío con su test de fixtures; `pnpm db:migrate` idempotente con advisory lock; usuario de solo lectura `fleet_ro`; scripts raíz `test:integration` y `test:e2e` |
| 4 | Orquestador | `docs/AGENTIC_SETUP.md` y ADR-001 del stack (TypeScript frente a Go, .NET, Cassandra y Druid) |
| 5 | `/arch-review` | Sin hallazgos críticos ni altos |

**Verificación**
- `pnpm typecheck` y `pnpm test` en verde.
- `docker compose up -d --wait` con todo `healthy`.
- `pnpm db:migrate` corrido dos veces seguidas sin error.
- Un test roto a propósito hace que el hook bloquee el turno. Es la prueba pendiente del hook con pnpm, que en el scratchpad no se pudo hacer por el límite de rutas de Windows.

## Fase 1 — Backend completo

Cuatro subfases en secuencia. Cada una lleva su rama, su `/arch-review` y su parte de `/e2e-check`.

**1a · `feat/ingest-pipeline`** (pasos 1 a 5 de `/e2e-check`)
- `/add-contract`: punto de telemetría (con `mocked` y `lowAccuracy`), lote, ACK con `accepted`/`rejected` por `eventId` y hora del servidor, mensaje de DLQ y token de dispositivo.
- Migraciones: tenants, vehículos, dispositivos y la hypertable `telemetry`, con índice único que incluye la columna de tiempo.
- `/new-usecase ingest-gateway`: recibir el lote. Responde `202` con ACK, `400` si el envelope está roto, `401`/`403`, `413` y `429` con `Retry-After`. Los inválidos van a `rejected` y a `telemetry.dlq`.
- `/new-usecase processor`: persistencia idempotente y commit de offsets después de persistir. Los inválidos de procesamiento van a la DLQ.
- Seed de los dos tenants ("Flota Norte" y "Flota Sur") y un comando local que emite tokens de dispositivo de prueba.

**1b · `feat/fleet-read-model`** (pasos 6 a 8)
- `/add-contract`: estado, alerta, zona (`critical`, `depot`, `customer`), resumen con hora del servidor, eventos SSE con snapshot ordenable y sesión.
- processor:
  - detención calculada con la hora del fix GPS;
  - zonas en PostGIS;
  - alertas.
- fleet-api:
  - login con cookie firmada y usuarios sembrados;
  - CORS con credenciales y origen explícito;
  - `/v1/summary`, `/v1/alerts`, `/v1/zones/geojson`, `/v1/vehicles/stopped`, `/v1/stream` y `/health`;
  - vinculación del dispositivo (`POST /v1/devices/pair`).
- Continuous aggregate como evidencia para A2.
- `pnpm simulate` con 30 vehículos repartidos en los dos tenants.

**1c · `feat/fleet-agent`** (pasos 9 y 10). Requiere `ANTHROPIC_API_KEY` en `.env`.
- `/add-contract`: chat con `toolCalls` y health con estado del breaker.
- `/new-usecase agent`:
  - herramientas tipadas (`get_stopped_vehicles` y las demás) con el tenant tomado de la sesión;
  - `services/agent/src/infrastructure/resilient-fleet-client.ts` con opossum;
  - `dependencies.fleetApi` en `:4003/health`.

**1d · `docs/adr-persistence`**
- ADR-002 de persistencia: lo redacta el orquestador con la evidencia que mide `backend-engineer` (EXPLAIN con exclusión de chunks y continuous aggregate).
- `/e2e-check` completo.

**Terminado**
- `pnpm test`, `pnpm test:integration` y `pnpm test:e2e` en verde.
- Pasos 1 a 11 de `/e2e-check` en `LISTO`, incluido el 8: un usuario de un tenant no ve nada del otro por API, SSE ni agente.
- Después, `develop` pasa a `master`.

## Fase 2 — Dashboard web (`web-engineer` → `/front-review`)

Fuera de alcance: cambios en `services/*`. Lo que haga falta del backend se propone y espera aprobación.

**2a · `feat/web-data-layer`**
- Arranca al cerrar la fase 1, o al cerrar 1b si los contratos del SSE ya están fijos.
- Entregables:
  - capa de API con `credentials` y tipos solo de `@fleet/contracts`;
  - un único cliente SSE en el que el snapshot llega como primer evento y reemplaza el estado (sin buffer ni carreras), con reconexión con backoff y nueva consulta de `/v1/alerts`;
  - store Zustand con funciones puras y sus tests.
- **Terminado:** tests unitarios del estado y de la reconexión, y typecheck, en verde.

**2b · `feat/web-dashboard`**
- El diseño ya está en `apps/web/design/`. El primer paso es pasar sus tokens a `src/design/tokens.ts`, que alimenta Tailwind y las capas de MapLibre. Si faltan tokens, se pregunta.
- Entregables:
  - login;
  - mapa MapLibre con zonas y vehículos como fuente GeoJSON actualizada con `setData`;
  - panel de KPIs y alertas en vivo;
  - chat con `toolCalls` y estado del breaker.
- **Terminado:**
  - con `pnpm dev` + `pnpm simulate` se ven 30 vehículos moviéndose;
  - al reiniciar fleet-api, el dashboard se reconecta solo y recupera el estado;
  - las alertas nuevas aparecen sin recargar;
  - el chat responde la pregunta de B1 y muestra los `toolCalls`;
  - con fleet-api caído, el chat muestra el breaker abierto y no inventa datos;
  - con el usuario de cada tenant solo se ven sus vehículos y alertas;
  - Playwright cubre esos seis flujos;
  - las pantallas coinciden con el diseño;
  - typecheck, test, build y test:e2e en verde;
  - `/front-review` sin hallazgos críticos ni altos.

## Fase 3 — App del conductor (`feat/mobile-driver-app`, `mobile-engineer` → `/front-review`)

Corre en paralelo con la fase 2. Reglas en [`apps/mobile/CLAUDE.md`](../apps/mobile/CLAUDE.md).

- **Requisitos del humano:** Maestro, un emulador Android (AVD) y el Android SDK. El development build sale de `pnpm expo run:android`, porque en Windows no funciona `eas build --local`.
- **Entregables:**
  - captura con `expo-location` en primer y segundo plano;
  - cola en `expo-sqlite` con estados y ACK;
  - sync por lotes con backoff y jitter;
  - vinculación con token guardado en `expo-secure-store`;
  - pantalla de diagnóstico;
  - flujos de Maestro en `apps/mobile/.maestro/`.
- **Terminado:**
  - tests de la cola en verde;
  - Maestro en verde: vincular, iniciar turno, ver pendientes y recuperar la conexión;
  - demo de modo avión → reconexión con puntos capturados = recibidos y sin duplicados.

## Fase 4 — Infraestructura, caos y CI (`devops-engineer` → `/arch-review`)

- **Requisitos del humano:** instalar k6, Terraform y actionlint (tflint es opcional).
- **4a, en paralelo con las fases 2 y 3:**
  - `feat/infra-terraform`: Terraform AWS como diseño. TimescaleDB autogestionado en EC2, porque RDS no lo trae. Incluye nota sobre multi-cuenta con Control Tower.
  - `feat/load-chaos`: k6 de modelo abierto con cientos de vehículos, 10% de duplicados reales, 5% de inválidos según la regla 7, escenarios de caos y verificación por conteos con SQL de solo lectura.
  - `feat/compose-app-profile`: Dockerfiles multi-stage de los cuatro servicios.
- **4b, después de 2b y 3:**
  - Dockerfile de la web en el perfil `app`.
  - `ci/mobile-eas-fastlane`: `eas.json`, Fastlane y workflow móvil, sin publicar.
- **Terminado:**
  - k6 de humo en verde con conteos correctos;
  - un escenario de caos documentado con su resultado;
  - `actionlint` limpio y `terraform validate` en verde;
  - `/e2e-check` también en verde contra `docker compose --profile app up -d --wait`.

## Fase 5 — Verificación integral

`/e2e-check` completo. Cada ❌ vuelve al subagente que indique el reporte, se revisa con su skill y se repite hasta `LISTO`.

## Fase 6 — Entregables (`docs/deliverables`)

- **`README.md`**, en este orden:
  1. qué es, con diagrama Mermaid;
  2. cómo correrlo en local;
  3. decisiones clave con enlace a cada ADR;
  4. IaC y por qué no se despliega;
  5. testing y caos, con resultados;
  6. auditoría de IA, con al menos 2 casos reales del log y nunca casos inventados;
  7. entorno agéntico: los CLAUDE.md, los 7 subagentes, las 8 skills, el hook, los permisos y el ciclo real con un ejemplo del repo.
- **`docs/VIDEO.md`**: guion de 5 a 10 minutos, con 2 minutos para el entorno agéntico usando un hallazgo real de un reviewer y su entrada en el log.
- **Repo público:** sin secretos en el historial, `.env.example` completo, licencia MIT y `git log` legible por fases.
- **Terminado:** `/e2e-check video` en `LISTO`, README revisado por el humano y checklist de repo público en verde.

## Decisiones

**Del humano**
- Autenticación mínima y multi-tenant real:
  - dos tenants sembrados;
  - login propio con cookie httpOnly firmada (`SameSite=Lax`) y secreto validado con zod;
  - CORS con credenciales entre `:3000` y `:4002`/`:4003`;
  - token por dispositivo, ligado a vehículo y tenant, guardado en `expo-secure-store`;
  - el paso 8 de `/e2e-check` es obligatorio.
- Docker Compose completo: el perfil `app` levanta todo; sin perfil, solo la infraestructura.
- El diseño del dashboard viene de Claude Design (`apps/web/design/`), y la fase 2 se divide en 2a y 2b.
- El e2e móvil se hace con Maestro.
- Ramas `master` y `develop`, con el flujo descrito arriba.
- El snapshot del SSE llega como primer evento del stream y reemplaza el estado.

**Aprobadas con este plan**
1. Todo el stack en TypeScript (Fastify 5, kafkajs, pg, LangChain `createAgent`, opossum). El ADR-001 lo justifica frente al stack de la empresa.
2. Cliente Kafka: kafkajs. Su mantenimiento está detenido; el ADR deja `@confluentinc/kafka-javascript`, que tiene API compatible, como salida.
3. Inválido de procesamiento: un punto fuera del área de operación (bbox de Colombia) pasa el esquema del gateway, pero el dominio del processor lo rechaza y lo manda a `telemetry.dlq` sin reintentos. Los errores transitorios reintentan con backoff y van a la DLQ al agotarse.
4. Token de dispositivo:
   - es opaco y se guarda con hash; el gateway lo valida con una caché corta;
   - si el `vehicleId` del payload no coincide con el del token, el punto va a `rejected`;
   - la vinculación usa un código de un solo uso.
5. Sesión: cookie firmada con HMAC. La validan fleet-api y agent; agent la reenvía a fleet-api, que sigue siendo quien filtra por tenant.
6. Los conteos de k6 y de la demo móvil salen de SQL de solo lectura (`fleet_ro`), sin endpoint público de conteo.
7. TimescaleDB en AWS autogestionado en EC2; Timescale Cloud queda como alternativa en el ADR.
8. Cola móvil con tope de 50 000 puntos. Al superarlo se descartan los más viejos, y lo descartado se cuenta y se muestra.
9. Tiles de OpenFreeMap con atribución visible. Umbral de "sin señal": 5 minutos contra la hora del servidor.
10. Licencia MIT. ADRs en `docs/adr/NNN-<tema>.md`.

## Riesgos y pendientes abiertos

- **Plazo de entrega:** sin definir. Con todo desde cero, los recortes se proponen apenas haya fecha y no al final. Los primeros candidatos, por su menor peso en la evaluación:
  - fidelidad pixel perfect solo en el dashboard principal;
  - un único escenario de caos;
  - Terraform con los módulos núcleo.
- **Memoria:** Docker tiene 7,6 GB asignados de 15,7 GB. El stack completo con el emulador Android abierto queda justo.
- **Agente:** el LLM no es determinista. En `/e2e-check` un fallo se reintenta una vez y, si pasa, se marca como ⚠️ flaky.
