# infra — Infraestructura (Compose, Terraform, k6)

Estas reglas complementan el `CLAUDE.md` de la raíz. El agente que trabaja aquí es `devops-engineer`; revisa `/arch-review`.

## Límites
- **Nada se despliega.** Terraform solo `fmt` y `validate` (`init -backend=false`); prohibidos `apply`, `destroy`, `import` y `state`. Sin comandos de AWS que modifiquen recursos.
- Sin secretos en archivos (ni ejemplos ni `*.tfvars` commiteados). No tocar `services/*`, `apps/*/src` ni `packages/*`: lo que la app necesite se reporta a `backend-engineer`.

## Docker Compose
- `docker-compose.yml` en la raíz, `name: fleet-telemetry`. **Sin perfil** levanta solo la infraestructura (`timescaledb`, `redpanda`, `redpanda-init`); `--profile app` levanta además `migrate`, `ingest-gateway`, `processor`, `fleet-api` y `agent`. **La web todavía no existe**: se agrega al perfil `app` (con el mismo Dockerfile parametrizado de `infra/docker/`) cuando exista.
- **Perfil `app`:**
  - Imágenes de `infra/docker/service.Dockerfile` (multi-stage, parametrizado por `SERVICE`; Node 24, `pnpm deploy --prod`, usuario `node`, sin secretos; `.dockerignore` en la raíz). Tag `fleet-telemetry/<servicio>:local`.
  - `migrate` es un servicio de un solo uso con el patrón de `redpanda-init`: corre `db:migrate`, queda inactivo y `healthy` (`up --wait` falla si un contenedor sale). El script es `set -eu`, borra `/tmp/migrated`, corre la migración y solo después hace `touch`: si la migración falla, el contenedor sale con error, su healthcheck nunca pasa y `up --wait` falla (sin `set -eu`, `sh -c` seguía y `up --wait` terminaba en éxito con el esquema sin migrar). `ingest-gateway`, `processor` y `fleet-api` dependen de él y de `redpanda-init`.
  - Los hosts internos (`timescaledb:5432`, `redpanda:9092`) se sobrescriben en el compose; el resto de variables (todas las opcionales de cada servicio, listadas sin valor) sale del entorno o de `.env` mediante la sustitución de compose, sin `env_file`. `ingest-gateway` publica `127.0.0.1:4001` (`INGEST_GATEWAY_HOST=0.0.0.0` dentro del contenedor) y `fleet-api` `127.0.0.1:4002` (`FLEET_API_HOST=0.0.0.0`, `SESSION_SECRET` y `FLEET_API_CORS_ORIGINS` desde `.env`); ambos tienen healthcheck contra `/health` (readiness: consulta la base; en AWS se usa `/health/live`). El `processor` no expone HTTP y por ahora no tiene healthcheck (pendiente para `backend-engineer`).
  - **Primera vez en un Redpanda compartido:** el processor consume `fromBeginning` y reprocesaría el backlog de otras pruebas; antes de levantar el perfil, fija su grupo con `node --env-file-if-exists=.env infra/k6/scripts/anchor-group.mjs`.
  - `agent` publica `127.0.0.1:4003` (`AGENT_HOST=0.0.0.0`, `FLEET_API_URL=http://fleet-api:4002`, `SESSION_SECRET` el mismo de `fleet-api`); depende de `fleet-api` healthy. `AGENT_MODEL_PROVIDER` (por defecto `anthropic`) y `ANTHROPIC_API_KEY` salen de `.env`, nunca del compose; sin clave el contenedor no arranca con `anthropic` (fail fast): para pruebas, `AGENT_MODEL_PROVIDER=scripted`. Healthcheck contra `/health/live` (`/health` da 503 con el breaker abierto). El job `infra` de CI fija `scripted`.
  - Puertos 4001, 4002 y 4003: si `pnpm dev` ya usa el gateway, `fleet-api` o el agente en el host, el contenedor no podrá publicarlos.
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
- Servicios y datos en subredes privadas; solo el ALB es público (443). El idle timeout del ALB debe cumplir **2 x heartbeat del SSE <= idle timeout < keep-alive de Fastify (72 s)**: **65 s en el ALB, y el backend debe enviar el heartbeat cada 30 s o menos** (requisito para `fleet-api`). Dos `precondition` lo garantizan; con 120 s el ALB mantenía conexiones que Fastify ya había cerrado y daba 502 intermitentes.
- **Liveness frente a readiness**: el healthcheck del contenedor de ECS y el del target group usan `/health/live` (sin dependencias); `/health` (consulta la base) es solo para compose y e2e. Con `/health` en ECS, un corte de la base mataría todas las tareas a la vez.
- **Secretos**: las contraseñas de la base y el `SESSION_SECRET` se generan con `ephemeral "random_password"` y se escriben con `secret_string_wo` (no quedan en ningún estado). Un secreto por rol (`db/admin`, `db/app`, `db/ro`) y un rol de ejecución por tarea que solo lee los suyos; solo `migrate` lee `db/admin`. Rotación con `credentials_version` (README). `ANTHROPIC_API_KEY` (`app/anthropic`) no se genera: es una variable **efímera** (`TF_VAR_anthropic_api_key`) escrita con `secret_string_wo` y `anthropic_api_key_version`, solo al crear o rotar; no queda en el estado.
- **Agente en AWS**: tarea Fargate `agent` (:4003, 0,25 vCPU / 0,5 GiB) con rol de tarea propio **sin permisos AWS** (no usa Kafka ni la base; todas las tareas tienen ahora su rol) y rol de ejecución que solo lee `SESSION_SECRET` y `ANTHROPIC_API_KEY`. ALB: `/v1/chat` y `/v1/chat/*` prioridad 150 (antes que el `/v1/*` de `fleet-api`, 200; el gateway es 100). Healthcheck `/health/live`. Llama a `fleet-api` por la **URL pública del ALB** (`agent_fleet_api_url`, decisión pendiente: depende del dominio), saliendo por el NAT; a la API del modelo, por el mismo NAT (443). `AGENT_TIMEOUT_MS` (60 s) queda por debajo del idle timeout del ALB (65 s).
- Código en `infra/terraform/` (ver su README): `bootstrap/` (estado remoto), `envs/dev` (plataforma; publica los brokers en SSM), `envs/dev-topics` (tópicos, desde dentro de la VPC con el SG `topics-admin`; lee los brokers de SSM, sin `terraform_remote_state`) y `modules/`. Orden de despliegue: plataforma con `desired_count = 0`, luego tópicos, luego servicios. Región, dominio/certificado y presupuesto son decisiones pendientes: variables sin valor por defecto. MSK Serverless domina el costo (~US$560 de ~US$690 al mes); ver el README.
- Validación local: `terraform fmt -check -recursive`, `init -backend=false` y `validate` por raíz, `tflint` y `trivy config`. Nada de `apply`.

## k6 (carga y caos)
- Modelo **abierto** (`ramping-arrival-rate` / `constant-arrival-rate`), con semilla y `vehicleId` fijos. Aborta si el objetivo es un dominio de producción.
- Mezcla: **10% de duplicados reales** (mismo `eventId` y payload) y **5% de inválidos** según la regla 7 (fuera de esquema, de procesamiento y envelope roto).
- Verificación por **conteos con SQL de solo lectura** (`fleet_ro`) y lectura de `telemetry.dlq`, tras esperar lag cero. **Sin endpoint público de conteo** (decisión aprobada 6).
- El caos se ejecuta con `docker compose` desde un script aparte, nunca desde k6; el criterio es que la verificación se cumpla igual tras la recuperación. Escenarios: `processor-restart` y `processor-outage` (SIGTERM, apagado ordenado: se exige **cero repetidos** en la DLQ) y `processor-kill` (SIGKILL dentro de la ráfaga: único que admite repetidos en la DLQ, por eventId distinto).
- Contadores de k6 independientes: `sent_*` se cuentan al enviar y `ack_*`/`response_400` de la respuesta; la verificación los compara (`infra/k6/lib/checks.js`, con tests).
- Código y resultados en `infra/k6/` (ver su README): `run.mjs` lanza k6, el caos opcional (`processor-restart|processor-outage|processor-kill`) y `verify.mjs`. Los tokens de los dispositivos de carga van a `infra/k6/.run/` (ignorado por git); la base solo guarda su sha256. Inválido de procesamiento = punto fuera de Colombia (`outside_operating_area`); no se simulan otros.
