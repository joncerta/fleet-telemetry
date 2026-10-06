# ADR-010 — Perfil `app` de compose, carga y caos con k6, y diseño de Terraform (fase 4a)

- **Estado:** aceptado
- **Fecha:** 2026-10-06
- **Numeración:** se usa 010 a propósito, lejos del último ADR de la rama principal, para no chocar con los que agregue la fase 1b; renumerar al integrar si hace falta.
- **Relacionados:** ADR-004 y ADR-005 (ingesta), decisiones aprobadas 6 y 7 de `docs/PLAN.md`.

## Decisiones

1. **Un solo Dockerfile parametrizado** (`infra/docker/service.Dockerfile`, `--build-arg SERVICE`, targets `service` y `migrate`) en vez de uno por servicio: los dos servicios (y los que vengan) se empaquetan igual. **`pnpm deploy --prod`** sobre `turbo prune`: deja la imagen final solo con `dist/` y las dependencias de producción (se verificó que no hay devDependencies), mientras `turbo prune` solo reduce el contexto de instalación. Usuario `node` (uid 1000), sin secretos en la imagen.
2. **`migrate` como servicio de un solo uso con el patrón de `redpanda-init`** (queda inactivo y healthy) en vez de `service_completed_successfully`: en compose v5.3 `up --wait` falla si un contenedor sale, aun con código 0. Si la migración falla, sale con error y `up` falla.
3. **El processor no tiene healthcheck** porque no expone HTTP. Se pide a `backend-engineer` una señal de salud; mientras tanto compose solo espera a que esté `running`.
4. **Verificación por conteos con prefijo de `eventId` por corrida**: los 8 primeros caracteres del UUID (v4 válido) salen del `RUN_ID`. Así la verificación aísla la corrida (en la base y en la DLQ) sin depender de relojes ni de borrar datos. Se descartó filtrar por ventana de tiempo (varias corridas se solapan en `recorded_at`) y limpiar el tenant (borrar de una hypertable compartida).
5. **Los inválidos de procesamiento son los puntos fuera de Colombia** (`outside_operating_area`): es el único que el processor rechaza sin reintentos. No se simula un fallo de la base como "inválido": es transitorio y no va a la DLQ (ADR-005.5).
6. **La DLQ se compara por `eventId` distinto**; sin interrupciones se exige además cero repetidos. La DLQ es at-least-once y no se deduplica (ADR-005.3), así que con caos se admite y se informa.
7. **Terraform en tres raíces**: `bootstrap` (bucket de estado), `envs/dev` (plataforma) y `envs/dev-topics` (tópicos). El proveedor de AWS no crea tópicos de MSK; el proveedor `Mongey/kafka` necesita llegar a los brokers desde dentro de la VPC, así que va en un estado aparte que se aplica desde un runner dentro de la red. Los tópicos salen de un módulo-catálogo único.
8. **Estado remoto con bloqueo nativo de S3** (`use_lockfile`, sin DynamoDB) y backend parcial (`backend "s3" {}` + `backend.hcl` local): ninguna configuración de cuenta en el repositorio.
9. **TimescaleDB en EC2 con el mismo contenedor que en local** (decisión aprobada 7), un nodo y snapshots diarios.
10. **ALB con idle timeout de 120 s** y heartbeat del SSE exigido de 30 s como máximo, con una `precondition` que obliga a 2 latidos de margen.
11. **Riesgos aceptados con `#trivy:ignore` y motivo**: salida 443 por NAT desde tareas y base, ALB público y bucket de estado sin access logs.

## Descartado

- Endpoints de VPC de interfaz en vez del NAT: ~US$58 al mes para ECR, Logs y Secrets Manager y no eliminan el NAT que la base necesita.
- MSK aprovisionado o Redpanda en EC2 para `dev`: más barato que MSK Serverless (~US$548 al mes solo por el clúster), pero la regla del proyecto fija MSK Serverless con IAM y TLS. Queda como pregunta de presupuesto.
- Un modelo de VUs cerrado en k6: no representa dispositivos que envían a ritmo fijo.

## Pendiente

- Región, dominio y certificado, y presupuesto (variables sin valor por defecto).
- Autenticación TLS y SASL/IAM de Kafka en los servicios (ADR-004, "Pendiente"), métricas `DlqMessages` y `BreakerOpen` de la app y un healthcheck del processor.
- Caos de Redpanda y de la base: fuera del alcance acordado (un solo escenario).
