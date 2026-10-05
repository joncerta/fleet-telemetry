# infra — Infraestructura (Compose, Terraform, k6)

Estas reglas complementan el `CLAUDE.md` de la raíz. El agente que trabaja aquí es `devops-engineer`; revisa `/arch-review`.

## Límites
- **Nada se despliega.** Terraform solo `fmt` y `validate` (`init -backend=false`); prohibidos `apply`, `destroy`, `import` y `state`. Sin comandos de AWS que modifiquen recursos.
- Sin secretos en archivos (ni ejemplos ni `*.tfvars` commiteados). No tocar `services/*`, `apps/*/src` ni `packages/*`: lo que la app necesite se reporta a `backend-engineer`.

## Docker Compose
- `docker-compose.yml` en la raíz, `name: fleet-telemetry`. **Sin perfil** levanta solo la infraestructura (`timescaledb`, `redpanda`, `redpanda-init`); `--profile app` levanta además servicios y web (fase 4).
- **Prohibido `docker compose down -v`** (regla de la raíz). Imágenes con tag fijo, nunca `latest`.
- `redpanda-init` crea los tópicos, desactiva `auto_create_topics_enabled` (propiedad de cluster, vía `rpk cluster config set`) y queda inactivo y `healthy`: en compose v5.3 `up --wait` falla si un contenedor sale durante la espera.
- Los puertos se publican solo en `127.0.0.1`: Postgres `5432`, Redpanda externo `19092`. Dentro de la red de compose, Redpanda es `redpanda:9092`.
- Credenciales por `.env` (copia de `.env.example`) con `${VAR:?mensaje}`.
- Marca de servidor `fleet.environment=local` (`command: ["postgres", "-c", "fleet.environment=local"]` en `timescaledb`): existe solo en local (y en CI, que usa el mismo compose); Terraform y AWS nunca la definen; `db:rollback` la exige (`current_setting('fleet.environment', true) = 'local'`).

## Migraciones
- Viven en `infra/db/migrations/` como pares `NNN_<nombre>.sql` y `NNN_<nombre>.down.sql`.
- Se aplican con `pnpm db:migrate`, se revierten con `pnpm db:rollback` (**solo contra una base local**: rechaza cualquier otro host; `--dry-run` muestra el plan sin tocar nada) y se consultan con `pnpm db:status`. Nunca por scripts de init ni montajes en el contenedor.
- La sesión de migración fija `lock_timeout` (`DB_MIGRATE_LOCK_TIMEOUT_MS`, 8 s por defecto): si se agota, reintenta en una ventana de menos carga.
- Las extensiones (`timescaledb`, `postgis`) y los roles `fleet_app` y `fleet_ro` los crea una migración.
- Tres usuarios: `fleet` (superusuario, solo migra, `DATABASE_ADMIN_URL`), `fleet_app` (DML, el de los servicios, `DATABASE_URL`) y `fleet_ro` (solo `SELECT`, `DATABASE_RO_URL`). Los servicios nunca conectan como superusuario.

## Tópicos
Key de todos: `vehicleId`. Creación explícita (sin autocreación): servicio `redpanda-init` en local y Terraform en AWS. Los valores de local salen de `docker-compose.yml`; si cambian, se actualiza esta tabla.

| Tópico | Particiones (local) | Retención (local) | Productor | Consumidor |
|---|---|---|---|---|
| `telemetry.raw` | 3 | 3 días | `ingest-gateway` | `processor` |
| `telemetry.dlq` | 1 | 14 días | `ingest-gateway`, `processor` | ninguno (se inspecciona a mano y en la verificación de k6) |
| `vehicle.state` | 3 | 1 día | `processor` | `fleet-api` |
| `fleet.alerts` | 3 | 3 días | `processor` | `fleet-api` |

## AWS
- **TimescaleDB:** autogestionado en EC2 (decisión aprobada 7 del plan), porque RDS no trae la extensión. Alternativa: Timescale Cloud, que quita la operación de la base pero añade un proveedor, su costo y peering de red.
- **Kafka:** MSK Serverless con autenticación IAM y TLS; tópicos creados con Terraform, con particiones y retención explícitas.
- Servicios y datos en subredes privadas; solo el ALB es público (443). El idle timeout del ALB debe superar el intervalo de heartbeat del SSE.

## k6 (carga y caos)
- Modelo **abierto** (`ramping-arrival-rate` / `constant-arrival-rate`), con semilla y `vehicleId` fijos. Aborta si el objetivo es un dominio de producción.
- Mezcla: **10% de duplicados reales** (mismo `eventId` y payload) y **5% de inválidos** según la regla 7 (fuera de esquema, de procesamiento y envelope roto).
- Verificación por **conteos con SQL de solo lectura** (`fleet_ro`) y lectura de `telemetry.dlq`, tras esperar lag cero. **Sin endpoint público de conteo** (decisión aprobada 6).
- El caos se ejecuta con `docker compose` desde un script aparte, nunca desde k6; el criterio es que la verificación se cumpla igual tras la recuperación.
