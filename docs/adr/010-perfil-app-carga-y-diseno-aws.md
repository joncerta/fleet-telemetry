# ADR-010 — Perfil `app` de compose, carga y caos con k6, y diseño de Terraform (fase 4a)

- **Estado:** aceptado
- **Fecha:** 2026-10-06
- **Numeración:** se usa 010 a propósito, lejos del último ADR de la rama principal, para no chocar con los que agregue la fase 1b; renumerar al integrar si hace falta.
- **Relacionados:** ADR-004 y ADR-005 (ingesta), decisiones aprobadas 6 y 7 de `docs/PLAN.md`.

## Decisiones

1. **Un solo Dockerfile parametrizado** (`infra/docker/service.Dockerfile`, `--build-arg SERVICE`, targets `service` y `migrate`) en vez de uno por servicio: los dos servicios (y los que vengan) se empaquetan igual. **`pnpm deploy --prod`** sobre `turbo prune`: deja la imagen final solo con `dist/` y las dependencias de producción (se verificó que no hay devDependencies), mientras `turbo prune` solo reduce el contexto de instalación. Usuario `node` (uid 1000), sin secretos en la imagen.
2. **`migrate` como servicio de un solo uso con el patrón de `redpanda-init`** (queda inactivo y healthy) en vez de `service_completed_successfully`: en compose v5.3 `up --wait` falla si un contenedor sale, aun con código 0. El script lleva `set -eu`, borra `/tmp/migrated`, corre la migración y solo después hace `touch`: si la migración falla, el contenedor sale con error, el healthcheck nunca pasa y `up --wait` falla. (Corrección de la revisión del PR #8: sin `set -eu`, `sh -c` seguía tras el fallo, creaba el archivo y `up --wait` terminaba en éxito con el esquema sin migrar. Reproducido y verificado con una contraseña mala.)
3. **El processor no tiene healthcheck** porque no expone HTTP. Se pide a `backend-engineer` una señal de salud; mientras tanto compose solo espera a que esté `running`.
4. **Verificación por conteos con prefijo de `eventId` por corrida**: los 8 primeros caracteres del UUID (v4 válido) salen del `RUN_ID`. Así la verificación aísla la corrida (en la base y en la DLQ) sin depender de relojes ni de borrar datos. Se descartó filtrar por ventana de tiempo (varias corridas se solapan en `recorded_at`) y limpiar el tenant (borrar de una hypertable compartida).
5. **Los inválidos de procesamiento son los puntos fuera de Colombia** (`outside_operating_area`): es el único que el processor rechaza sin reintentos. No se simula un fallo de la base como "inválido": es transitorio y no va a la DLQ (ADR-005.5).
6. **La DLQ se compara por `eventId` distinto**; sin interrupciones, y con las interrupciones ordenadas (`processor-restart`, `processor-outage`: SIGTERM, el consumer termina el tramo y confirma antes de salir), se exige además **cero repetidos**. Solo `processor-kill` (`kill -s SIGKILL`, 5 s y `start`, lanzado dentro de la ráfaga offline con lotes en vuelo) admite repetidos: es el único que puede matar al proceso entre persistir un tramo y confirmar su offset, el fallo real del at-least-once (ADR-005.3). Antes el caos solo usaba SIGTERM y toleraba repetidos, así que no ejercitaba el fallo que decía probar.
6b. **Contadores de k6 independientes**: `sent_*` se cuenta al enviar (lo que el script construyó) y `ack_accepted`, `ack_rejected` y `response_400` salen de la respuesta, antes de las comprobaciones por lote. Si ambos lados se alimentaran de la misma variable, comparar lo enviado con lo observado sería una tautología. La lógica de comparación vive en `infra/k6/lib/checks.js` y tiene tests.
7. **Terraform en tres raíces**: `bootstrap` (bucket de estado), `envs/dev` (plataforma) y `envs/dev-topics` (tópicos). El proveedor de AWS no crea tópicos de MSK; el proveedor `Mongey/kafka` necesita llegar a los brokers desde dentro de la VPC, así que va en un estado aparte que se aplica desde un runner dentro de la red. Los tópicos salen de un módulo-catálogo único. `envs/dev` publica los brokers en un `aws_ssm_parameter` y `dev-topics` los lee con un data source: **sin `terraform_remote_state`**, que daría a la raíz de tópicos lectura de todo el estado de la plataforma. Un SG `topics-admin` (único origen, además de las tareas, que MSK admite) y una política IAM mínima (`topics_admin`) acompañan al runner. Orden de despliegue: plataforma con los tres `desired_count = 0`, luego tópicos, luego los servicios (README de Terraform).
8. **Estado remoto con bloqueo nativo de S3** (`use_lockfile`, sin DynamoDB) y backend parcial (`backend "s3" {}` + `backend.hcl` local): ninguna configuración de cuenta en el repositorio.
9. **TimescaleDB en EC2 con el mismo contenedor que en local** (decisión aprobada 7), un nodo y snapshots diarios.
10. **ALB con idle timeout de 65 s**, heartbeat del SSE exigido de 30 s como máximo y keep-alive de Fastify de 72 s: 2 x 30 <= 65 < 72, garantizado por dos `precondition`. Con 120 s (antes) el ALB mantenía conexiones que Fastify ya había cerrado a los 72 s y daba 502 intermitentes.
10b. **Liveness frente a readiness**: el healthcheck del contenedor de ECS y el del target group usan `/health/live` (sin dependencias). `/health` consulta la base (readiness) y queda para compose y los e2e: con él en ECS, un corte de la base fallaría el healthcheck de todas las tareas a la vez, ECS las mataría y el ALB se quedaría sin destinos. `/health/live` lo agrega `backend-engineer` en `ingest-gateway` y `fleet-api` (pendiente hasta que se integre).
10c. **Credenciales fuera de todo estado**: las contraseñas de la base y el `SESSION_SECRET` se generan con recursos `ephemeral "random_password"` y se escriben con `secret_string_wo` y `secret_string_wo_version` (aws 6.67, random 3.9): no quedan en el estado de Terraform ni en el plan, y Secrets Manager es su única copia. Un secreto por rol (`db/admin`, `db/app`, `db/ro`) y un rol de ejecución por tarea, que solo lee los secretos de sus propias `secrets`: únicamente `migrate` lee `db/admin`. La rotación sube `credentials_version` (README). Se descartó `random_password` normal (queda en el estado).
10d. **`fleet-api` en el perfil `app` y detrás del ALB**: puerto 4002 en compose (`FLEET_API_HOST=0.0.0.0`, `SESSION_SECRET` y `FLEET_API_CORS_ORIGINS` desde `.env`, healthcheck contra `/health`); en AWS, regla `/v1/*` con prioridad 200 (el gateway, `/v1/telemetry/*`, tiene la 100 y se evalúa antes).
10e. **CI de infraestructura**: el job `infra` corre las pruebas de `infra/k6/lib`, levanta el perfil `app`, ejecuta el humo de k6 con su verificación y valida Terraform (`fmt`, `validate`, `tflint`, `trivy config`) por Docker.
11. **Riesgos aceptados con `#trivy:ignore` y motivo**: salida 443 por NAT desde tareas y base, ALB público y bucket de estado sin access logs.

## Descartado

- Endpoints de VPC de interfaz en vez del NAT: ~US$58 al mes para ECR, Logs y Secrets Manager y no eliminan el NAT que la base necesita.
- MSK aprovisionado o Redpanda en EC2 para `dev`: más barato que MSK Serverless (~US$548 al mes solo por el clúster), pero la regla del proyecto fija MSK Serverless con IAM y TLS. Queda como pregunta de presupuesto.
- Un modelo de VUs cerrado en k6: no representa dispositivos que envían a ritmo fijo.

## Pendiente

- Región, dominio y certificado, y presupuesto (variables sin valor por defecto).
- Autenticación TLS y SASL/IAM de Kafka en los servicios (ADR-004, "Pendiente"), métricas `DlqMessages` y `BreakerOpen` de la app y un healthcheck del processor.
- `GET /health/live` en `ingest-gateway` y `fleet-api` (backend-engineer): sin él, los healthchecks de ECS y del ALB fallan.
- Nombre del consumer group de `fleet-api` para SSE (la política IAM propone `fleet-api-*`).
- Caos de Redpanda y de la base: fuera del alcance acordado (un solo escenario).
