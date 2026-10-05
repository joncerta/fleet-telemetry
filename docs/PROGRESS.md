# Progreso

| Fase | Estado | Evidencia |
|---|---|---|
| 0 — Entorno agéntico y esqueleto | completa | Confirmado por el humano el 2026-10-05. `/arch-review` APROBADO (0 críticos, 0 altos). CI del PR #3 en verde. Mergeado en `develop` (`f6275da`). Sin `/e2e-check`, porque todavía no hay servicios |
| 1a — Ingesta (`feat/ingest-pipeline`) | pendiente | — |
| 1b — Read model | pendiente | — |
| 1c — Agente IA | pendiente | — |
| 1d — ADR de persistencia y `/e2e-check` | pendiente | — |
| 2a / 2b — Web | pendiente | — |
| 3 — Móvil | pendiente | — |
| 4a / 4b — Infra, caos y CI móvil | pendiente | — |
| 5 — Verificación integral | pendiente | — |
| 6 — Entregables | pendiente | — |

**Entrega: martes 2026-10-06, sin recortes de alcance** (decisión del humano).

## Siguiente

**Próximo paso:** fase 1a, en la rama `feat/ingest-pipeline` que sale de `develop`.
1. Commit `fix(platform)` (`backend-engineer`) con los 5 medios de la última revisión:
   - el logger no limpia un `Error` de `pg` guardado bajo una clave distinta de `err`/`error`;
   - `URL` y `Buffer` en el log (sospecha);
   - `?options=` en `DATABASE_ADMIN_URL`;
   - el arnés no desenvuelve `.default()`, `.readonly()` ni `.transform()`;
   - alias de `Date` y `Math` en `domain/`.
2. `/add-contract`: punto de telemetría (con `mocked` y `lowAccuracy`), lote, ACK, mensaje de DLQ y token de dispositivo.
3. Migraciones: tenants, vehículos, dispositivos y la hypertable `telemetry`. Son pares up/down; el índice único incluye la columna de tiempo.
4. `/new-usecase ingest-gateway` y `/new-usecase processor`.
5. Seed de "Flota Norte" y "Flota Sur", y el comando de tokens de prueba.
6. `/arch-review`.

**Antes de la 1a:** mergear el PR de `docs/phase0-progress` (este archivo y `docs/AI_AUDIT_LOG.md`).

**Bloqueos y requisitos:**
- 1a: ninguno.
- 1c: `ANTHROPIC_API_KEY` en `.env`.
- Fase 3: Android SDK, un AVD y Maestro.
- Fase 4: k6, Terraform y actionlint.
- **Antes de paralelizar las fases 2, 3 y 4a:** arreglar el hook. Hoy verifica todo el árbol, toma la raíz de `CLAUDE_PROJECT_DIR`, su salida trae colores ANSI y no cubre `tests/e2e`.

**Cómo retomar:**
- `git switch develop && git pull`
- `docker compose up -d --wait`
- `pnpm install --frozen-lockfile && pnpm build`
- `pnpm db:status`: debe mostrar 0 pendientes.
- Leer primero `docs/PLAN.md` (fase 1), `CLAUDE.md`, `infra/CLAUDE.md` y `docs/adr/003-monorepo-y-migraciones.md`.
- Los implementadores corren en primer plano y uno por vez, por la limitación del hook.

## Sesión 2026-10-05 — chore/phase0-skeleton (PR #3 → develop)

**Hecho**
- **Stack local con Docker Compose:**
  - TimescaleDB + PostGIS y Redpanda, con los 4 tópicos creados explícitamente y la autocreación desactivada;
  - marca de servidor `fleet.environment=local`;
  - `.env.example` con tres usuarios.
- **Monorepo:** pnpm + Turborepo + TypeScript estricto (Node 24), Vitest en tres niveles (unitario, integración y e2e) y ESLint con una regla que hace cumplir la pureza de `domain/`.
- **`@fleet/contracts`:** arnés de compatibilidad hacia atrás y hacia adelante, con registro completo. Sin esquemas todavía.
- **`@fleet/platform`:**
  - config que falla al arrancar sin mostrar valores;
  - logger con redacción profunda de datos personales;
  - producer kafkajs idempotente con `acks=-1` y `correlationId` obligatorio;
  - pool de `pg`.
- **Migraciones reversibles** (`db:migrate`, `db:status`, `db:rollback`) con checksums de up y down, advisory lock y `lock_timeout`. El rollback solo corre contra una base local. La 001 crea las extensiones y los roles `fleet_app` y `fleet_ro`, con contraseñas enviadas como verificador SCRAM.
- **Smoke e2e** de infraestructura.
- **CI:** jobs `verify` e `integration`, sobre el mismo compose y con las actions fijadas a SHA.
- **Documentación:** ADR-001 y ADR-003, `docs/AGENTIC_SETUP.md`, y `CLAUDE.md` más las skills `/e2e-check` y `/new-usecase` actualizados a migraciones reversibles.
- `docs/AI_AUDIT_LOG.md`, con las entradas 1 a 3.

**Decisiones**
- Node 24 LTS, porque Node 20 dejó de tener soporte el 2026-04-30 ([ADR-001](adr/001-stack.md)).
- TypeScript de punta a punta, con kafkajs y `@confluentinc/kafka-javascript` como salida ([ADR-001](adr/001-stack.md)).
- Migraciones reversibles con par up/down obligatorio, por decisión del humano ([ADR-003](adr/003-monorepo-y-migraciones.md)).
- Tres usuarios de base de datos por mínimo privilegio: `fleet` migra, `fleet_app` es el de los servicios y `fleet_ro` es de solo lectura ([ADR-003](adr/003-monorepo-y-migraciones.md)).
- Contraseñas de roles como verificador SCRAM, para que nunca viajen en claro ni queden en el log de Postgres ([ADR-003](adr/003-monorepo-y-migraciones.md)).
- `db:rollback` solo en local, con allowlist de host y marca de servidor ([ADR-003](adr/003-monorepo-y-migraciones.md)).
- `redpanda-init` queda inactivo y `healthy`, porque en compose v5.3 `up --wait` falla si un contenedor sale. Sin ADR; está en `infra/CLAUDE.md`.
- El CI usa el mismo `docker-compose.yml` y no service containers, para tener una sola definición de versiones. Sin ADR.
- Los implementadores corren en secuencia, por el hook. Sin ADR; está en `docs/AGENTIC_SETUP.md`.
- `vehicleId`, que es un UUID interno y no la placa, se permite en los logs (regla 16). Lo asumió el orquestador y el humano no objetó. Sin ADR.

**Verificación**
- Suite local, corrida por el orquestador tras la última corrección: build, typecheck, lint y test en verde; `test:integration` 75; `test:e2e` 9.
- Reportado por `backend-engineer`: eslint-config 82, contracts 26 y platform 267; `db:migrate` dos veces y `db:status` con 0 pendientes y 0 discrepancias; `psql -U fleet_ro` puede leer y no puede crear tablas.
- Reportado por `devops-engineer`: `up --wait` tres veces con exit 0; 4 tópicos con particiones y retención; autocreación en `false`; actionlint (por Docker) sin hallazgos.
- Hook: un test roto a propósito bloqueó el cierre real de un turno (código 2).
- `/arch-review`: APROBADO CON CAMBIOS (1 alto, 13 medios), luego APROBADO (7 medios) y luego APROBADO (5 medios nuevos).
- CI del PR #3: `verify` en 50 s e `integration` en 1 min 35 s, los dos en verde.
- `/e2e-check`: no aplica en la fase 0.

**Problemas abiertos**
- 5 medios de la tercera revisión: primer commit de la 1a (ver Siguiente).
- El snapshot de migraciones compara funciones y vistas solo por nombre: fase 1d, con el primer continuous aggregate.
- El hook asume un solo agente: arreglarlo antes de paralelizar (ver Siguiente).
- `.claude/skills/new-usecase/SKILL.md:46` dice que el test "prueba el down automáticamente": hay que alinearlo con la cobertura real del ADR-003.
- El scheduler de Timescale mantiene una conexión a `template1`, así que `CREATE DATABASE ... TEMPLATE template1` falla. Los tests usan `template0`.
- `redpanda-init` no corrige la deriva de configuración de tópicos ya creados: `devops-engineer`, fase 4a.
- Throughput del producer (`maxInFlightRequests: 1`) y reintentos acotados: gateway, en la 1a.
- `AGENTS.md` aparece modificado solo por el fin de línea (Turborepo): resolverlo con `.gitattributes` y `eol=lf`.
- Protección de ramas con `CI / verify` y `CI / integration` obligatorios: TODO (humano).
- `docs/PLAN.md:54` dice "sin push todavía", y quedó viejo. El cambio lo aprueba el humano.
- Checklist del revisor: prohibir `rejects.toThrow()` sin patrón (propuesta de la entrada 3 del log de auditoría, todavía sin aplicar).

Último commit registrado: `f6275da`
