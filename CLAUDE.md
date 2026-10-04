# CLAUDE.md — Reglas del proyecto Fleet Telemetry

Contexto permanente para Claude Code. El objetivo NO es generar código rápido: es generar código que un arquitecto senior aprobaría en code review.
Este archivo define invariantes y decisiones. El "cómo" de cada área vive en `.claude/agents/` y en el `CLAUDE.md` de cada carpeta (`apps/web`, `apps/mobile`, `infra`).

## Qué es este sistema
Portal de monitoreo de flotas:

app móvil offline-first → `ingest-gateway` → Kafka (Redpanda local / MSK Serverless en AWS) → `processor` → TimescaleDB + PostGIS → `fleet-api` (REST + SSE) → dashboard Next.js.

Un agente LangChain responde preguntas en lenguaje natural usando herramientas tipadas sobre `fleet-api`.

## Mapa del monorepo
- `packages/contracts` — esquemas zod 4 compartidos. **Fuente única de verdad** de eventos, DTOs, ACK y SSE.
- `packages/platform` — fábricas de infraestructura (Kafka, Postgres, config, logger). Sin lógica de negocio.
- `services/ingest-gateway` (:4001) — HTTP → valida → produce a `telemetry.raw` (key = `vehicleId`); inválidos a `telemetry.dlq`.
- `services/processor` — consume `telemetry.raw` → persiste idempotente → actualiza `vehicle_state` → produce `vehicle.state` y `fleet.alerts`.
- `services/fleet-api` (:4002) — read model REST + SSE; consume `vehicle.state` y `fleet.alerts`.
- `services/agent` (:4003) — agente LangChain; habla con `fleet-api` detrás de un circuit breaker.
- `apps/web` (Next.js) y `apps/mobile` (Expo) — fases siguientes.
- `infra/` — Terraform, `infra/db/migrations/` y configuración local.
- `docs/adr/` decisiones · `docs/AI_AUDIT_LOG.md` correcciones a la IA · `docs/PROGRESS.md` estado.

## Reglas de arquitectura (NO negociables)
1. **Clean Architecture por servicio**:
   - `domain/`: puro, sin I/O ni imports de infraestructura.
   - `application/`: casos de uso que dependen de puertos (interfaces).
   - `infrastructure/`: adaptadores de Kafka, `pg` y HTTP.
   - `interfaces/`: HTTP, consumers, SSE y herramientas del agente.
   - `main.ts` es el único composition root.
2. **Nada de lógica de negocio en handlers, consumers ni herramientas del agente.** Validan, llaman un caso de uso y mapean la respuesta.
3. **Contratos**: todo payload que cruza un límite (HTTP, Kafka, SSE, herramienta del agente) se valida con un esquema de `@fleet/contracts`. Prohibido duplicar tipos en los servicios. Los cambios de contrato se hacen con `/add-contract`: aditivos por defecto, y los incompatibles requieren aprobación.
4. **Multi-tenant**:
   - Todo dato pertenece a un tenant.
   - El `tenantId` sale de la identidad autenticada, nunca de body, query, payload ni argumentos del LLM.
   - Toda consulta, stream SSE y herramienta del agente filtra por tenant.
5. **Idempotencia de punta a punta**: el `eventId` (UUID) lo genera el dispositivo al capturar el punto. La persistencia usa `ON CONFLICT DO NOTHING`; en hypertables, el índice único incluye la columna de tiempo. Nunca deduplicar solo en memoria.
6. **Kafka**:
   - Key = `vehicleId`, para mantener el orden por vehículo.
   - Producer idempotente con `acks=-1`.
   - Commit de offsets **solo después de persistir** (at-least-once + sink idempotente = efectivamente una vez).
   - Cada réplica que alimenta SSE recibe todos los eventos de sus tenants: no comparten consumer group.
7. **Inválidos y DLQ**:
   - **Gateway**: un lote con envelope roto (JSON inválido o sin la estructura base) → `400`, sin DLQ. Cada punto que no cumple el esquema → va en `rejected` del ACK con su motivo **y** se publica en `telemetry.dlq` con el motivo y el payload original.
   - **Processor**: un mensaje que falla al procesar tras agotar los reintentos → `telemetry.dlq` con el motivo.
   - Nada inválido detiene una partición ni se descarta sin rastro.
8. **ACK del lote**:
   - El gateway responde `accepted` y `rejected` por `eventId`.
   - Un reenvío de puntos ya persistidos los devuelve en `accepted`; si no, el móvil los reintentaría para siempre.
   - El ACK incluye la hora del servidor.
9. **SSE**:
   - Cada evento lleva `id:` y hay heartbeat periódico.
   - El snapshot inicial incluye una referencia (último `id` o secuencia) ordenable contra los eventos.
   - Autenticación por cookie, nunca token en la URL.
10. **Agente IA**:
    - PROHIBIDO text-to-SQL o que el LLM construya queries. Solo herramientas tipadas con esquema zod y límites (`limit`, rangos).
    - El `tenantId` se inyecta desde el servidor. Solo lectura por defecto.
    - Si una herramienta falla, el agente lo dice; nunca inventa datos.
11. **Resiliencia**:
    - Toda llamada entre microservicios pasa por circuit breaker (opossum), creado una vez por dependencia (no por request).
    - Con timeout, `errorFilter` (los 4xx no abren el circuito) y un fallback explícito que nunca se hace pasar por datos reales.
12. **SQL**:
    - Siempre parametrizado (`$1`), sin concatenar strings. Los identificadores dinámicos salen de una allowlist.
    - Consultas de listado con `LIMIT`; consultas a hypertables con rango de tiempo.
13. **Tiempo y geografía**:
    - `timestamptz` en UTC. El tiempo de un punto es el del fix GPS del dispositivo; el del servidor se guarda aparte.
    - Coordenadas siempre en orden longitud, latitud: `ST_MakePoint(lon, lat)`, `[lng, lat]` en el mapa, SRID 4326.
    - Área de operación: Colombia.
14. **Privacidad**: posición y datos del conductor son datos personales (Ley 1581). Nunca en logs, analítica ni reportes de error.
15. **Configuración**: variables de entorno validadas con zod al arrancar (fail fast) y documentadas en `.env.example`. Nada de secretos en el código.
16. **Observabilidad**: logs estructurados con `correlationId`, `tenantId` y `vehicleId`. El `correlationId` viaja de HTTP a los headers de Kafka.
17. **Tests obligatorios en todo cambio**. Ningún cambio, nuevo o modificado, se entrega sin sus tests:
    - **Unitarios** (Vitest) de toda lógica nueva o modificada: dominio, casos de uso, stores y hooks del front, cola del móvil. No tocan red ni DB.
    - **Integración** de adaptadores SQL y consumers contra TimescaleDB y Redpanda reales (`pnpm test:integration`).
    - **E2E del flujo afectado**: un flujo nuevo agrega su test; uno modificado actualiza el existente.
      - Backend: `tests/e2e/` contra el stack real (`pnpm test:e2e`).
      - Web: Playwright.
      - Móvil: la herramienta definida en `apps/mobile/CLAUDE.md`.
    - **Contratos**: fixtures de la versión anterior, que deben seguir parseando.
    - **Bugs**: todo bug corregido lleva primero un test que lo reproduce.
    - Prohibido `.skip`, `.only`, borrar o debilitar aserciones y regenerar snapshots para que pasen.

## Migraciones
- Archivos nuevos en `infra/db/migrations/NNN_<nombre>.sql`, con el siguiente número libre. Nunca se edita una existente.
- Se aplican con `pnpm db:migrate`. Los scripts de inicio del contenedor solo corren con el volumen vacío: **no** sirven para migraciones nuevas, y `docker compose down -v` está prohibido.

## Convenciones
- TypeScript estricto, ESM (`"type": "module"`), imports con extensión `.js`.
- Nombres de dominio en inglés en el código; documentación y mensajes al usuario en español.
- Ramas:
  - `master`: lo entregado. Solo recibe `develop` al cerrar una fase con `/e2e-check` en `LISTO`.
  - `develop`: integración. Cada cambio sale en una rama propia desde `develop` (`feat/*`, `fix/*`, `chore/*`, `docs/*`, `ci/*`) y vuelve por PR.
  - Las revisiones de rama (`/arch-review rama`, `/front-review rama`) comparan contra `develop`.
- Commits (solo cuando el humano lo pide): Conventional Commits (`feat(processor): ...`), un commit por cambio lógico.

## Agentes y skills
Subagentes (`.claude/agents/`):
- Implementan: `backend-engineer`, `web-engineer`, `mobile-engineer`, `devops-engineer`.
- Revisan (no editan): `architect-reviewer` (back) y `frontend-reviewer` (web, móvil, pixel perfect).
- Verifica (no corrige): `qa-verifier`.

Skills (`.claude/skills/`):
- Sesión: `/session-start`, `/session-handoff`.
- Construcción: `/new-usecase`, `/add-contract`.
- Revisión: `/arch-review`, `/front-review`.
- Verificación: `/e2e-check`.
- Auditoría: `/ai-audit-entry`.

`/session-start`, `/session-handoff` y `/ai-audit-entry` solo las invoca el humano: Claude las **propone**, no las ejecuta.

## Flujo de trabajo
1. Cada sesión empieza con `/session-start` y termina con `/session-handoff`.
2. **Plan primero**: en cambios no triviales, propone el plan y espera aprobación antes de escribir código.
3. Implementa con el subagente del área. Los contratos van antes que sus productores y consumidores.
4. Antes de proponer un commit:
   - suite e2e completa en verde;
   - `/arch-review` si se tocó back, `/front-review` si se tocó web o móvil.

   Con hallazgos críticos o altos (un test faltante es alto), se corrigen antes de seguir.
5. Una fase solo se da por completa con `/e2e-check` en `LISTO`.
6. Nunca hagas commit ni push sin que el humano lo pida.

## Antes de terminar cualquier tarea
1. **Tests por niveles**:
   - **Automático**: al terminar cada turno o subagente, un hook (`tools/hooks/verify-affected.mjs`) corre typecheck y tests unitarios de los paquetes afectados. Si fallan, no se puede terminar; tras 3 bloqueos seguidos deja cerrar, y la tarea se reporta como NO terminada.
   - **Al cerrar cada tarea**: tests unitarios, de integración y e2e de los flujos afectados, en verde. Si el stack local no está arriba, el e2e queda "no verificado" y **la tarea no se da por terminada**: se pide al humano que lo levante.
   - **Antes de proponer un commit**: suite e2e completa (`pnpm test:e2e`) en verde.
2. Si tomaste una decisión de arquitectura, agrega o actualiza un ADR en `docs/adr/`.
3. Si se corrigió una sugerencia deficiente de la IA, propone `/ai-audit-entry <título>` al humano.
4. No edites `docs/PROGRESS.md` por tu cuenta: se actualiza con `/session-handoff`.

## Comandos
- `docker compose up -d` — Redpanda + TimescaleDB.
- `pnpm install && pnpm build` — compila todo.
- `pnpm db:migrate` — aplica migraciones pendientes.
- `pnpm dev` — levanta todos los servicios en modo watch (lo corre el humano).
- `pnpm simulate` — simulador de vehículos.
- `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e` — verificación (unitarios, integración y e2e).
