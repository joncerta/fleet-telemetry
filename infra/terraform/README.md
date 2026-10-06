# Terraform (AWS): diseño del ambiente `dev`

**Este código no se despliega.** Es el diseño de la infraestructura de AWS, con `fmt`, `validate`, `tflint` y un escáner de seguridad en verde.
Prohibidos `apply`, `destroy`, `import` y `state` (ver [`infra/CLAUDE.md`](../CLAUDE.md)). Un `plan` real necesita las decisiones de la sección "Decisiones pendientes".

## Estructura

```
infra/terraform/
├── bootstrap/        bucket S3 del estado remoto (cifrado, versionado) y su clave KMS. Se aplica una vez por cuenta.
├── envs/
│   ├── dev/          plataforma: red, datos, servicios, alarmas y presupuesto.
│   └── dev-topics/   tópicos de Kafka (aparte: el proveedor `kafka` debe llegar a los brokers desde dentro de la VPC).
└── modules/
    ├── kms/              una clave por ambiente (logs, secretos, EBS, ECR, SNS).
    ├── network/          VPC, subredes públicas y privadas, NAT, endpoint de S3, flow logs.
    ├── ecr/              un repositorio por imagen (tags inmutables, escaneo al publicar, ciclo de vida).
    ├── msk/              MSK Serverless con SASL/IAM y TLS.
    ├── topic-catalog/    fuente única de los tópicos (nombre, particiones, retención).
    ├── kafka-topics/     crea los tópicos de forma explícita (proveedor Mongey/kafka con SASL/IAM).
    ├── timescaledb/      TimescaleDB autogestionado en EC2 (decisión aprobada 7).
    ├── ecs-services/     clúster Fargate, ALB público solo en 443, servicios y jobs de un solo uso.
    └── observability/    alarmas, tema SNS cifrado.
```

Versiones fijadas: Terraform `~> 1.16`, proveedores `aws ~> 6.67`, `random ~> 3.9`, `Mongey/kafka ~> 0.13`. Los `.terraform.lock.hcl` se versionan (con hashes de linux amd64 y arm64, macOS arm64 y Windows).
Todo recurso lleva las etiquetas `project`, `env`, `owner`, `cost-center` y `managed-by` por `default_tags` del proveedor.

## Estado remoto

Estado en S3 con cifrado KMS, versionado del bucket, bloqueo de acceso público, TLS obligatorio y **bloqueo nativo** (`use_lockfile`, Terraform 1.10 o superior, sin tabla de DynamoDB).
La configuración del backend **no va en el repositorio**: cada raíz declara `backend "s3" {}` y se inicializa con un archivo local (`backend.hcl`, ignorado por git) que sale de `backend.hcl.example`:

```bash
cp envs/dev/backend.hcl.example envs/dev/backend.hcl   # completa bucket, región y clave KMS; sin credenciales
terraform -chdir=envs/dev init -backend-config=backend.hcl
```

Las credenciales salen del entorno (OIDC en CI, SSO o variables `AWS_*` en local), nunca de archivos.
`bootstrap/` crea el bucket y es la **única excepción al estado remoto**: arranca con estado local (el .tfstate está ignorado por git y solo contiene ARN) y después migra su propio estado al bucket (`terraform init -migrate-state`; instrucciones en su `main.tf`).

## Cómo validar (sin desplegar)

```bash
terraform fmt -check -recursive
for root in bootstrap envs/dev envs/dev-topics; do
  terraform -chdir=$root init -backend=false && terraform -chdir=$root validate
done
tflint --recursive --config "$(pwd)/.tflint.hcl"          # desde infra/terraform
trivy config --severity LOW,MEDIUM,HIGH,CRITICAL .          # o la imagen aquasec/trivy
```

Nota para Windows con antivirus que inspecciona TLS (Avast): el mTLS de loopback entre Terraform y sus proveedores falla con `x509: certificate signed by unknown authority` y `validate` no arranca. Se evita corriendo Terraform en Docker (`hashicorp/terraform`, con un volumen para `TF_DATA_DIR`), que es como se verificó aquí.

## Decisiones pendientes (el plan falla hasta definirlas)

Ninguna se adivinó; son variables sin valor por defecto (ver `envs/dev/terraform.tfvars.example`):

| Variable | Pregunta |
|---|---|
| `aws_region` | ¿Qué región? Debe tener MSK Serverless. Afecta precios y la residencia de datos (Ley 1581). |
| `certificate_arn` | ¿Qué dominio sirve el ALB? Hace falta un certificado ACM en la misma región. |
| `monthly_budget_usd`, `budget_emails` | ¿Presupuesto mensual y quién recibe las alertas? |
| `owner`, `cost_center` | Valores de las etiquetas. |
| `image_tag` | Lo fija el pipeline de despliegue (SHA del commit): los tags de ECR son inmutables. |

## Decisiones de diseño

- **TimescaleDB en EC2** (no RDS: no trae la extensión). Contenedor con la **misma imagen que `docker-compose.yml`**, datos en un EBS gp3 aparte cifrado con KMS, snapshots diarios con retención de 7 días (DLM), sin IP pública ni llave SSH (SSM Session Manager). Un solo nodo, sin réplica: es `dev`. Alternativa descartada: Timescale Cloud (menos operación, pero otro proveedor, su costo y peering de red).
- **MSK Serverless** con IAM y TLS. El proveedor de AWS no tiene recurso para tópicos, así que los crea el módulo `kafka-topics` con el proveedor `Mongey/kafka` en una raíz aparte (`envs/dev-topics`), que se aplica desde dentro de la VPC (runner autoalojado o túnel SSM). Los tópicos salen de `modules/topic-catalog`, que debe coincidir con la tabla de `infra/CLAUDE.md` y con `redpanda-init` de `docker-compose.yml`.
- **Permisos de Kafka por tópico y grupo**: el gateway solo escribe en `telemetry.raw` y `telemetry.dlq`; el processor lee `telemetry.raw`, escribe en la DLQ, `vehicle.state` y `fleet.alerts`, y solo usa su consumer group.
- **Red**: servicios, base y MSK en subredes privadas. Solo el ALB es público y solo en 443 (no hay listener 80). Cada regla de entrada tiene como origen otro SG, salvo el 443 del ALB. Un NAT compartido (dev) y un endpoint de S3 gratuito para las capas de ECR.
- **ECS Fargate**: 0,25 vCPU y 512 MiB por tarea, 1 réplica por servicio, sistema de archivos raíz de solo lectura y usuario no root. Un despliegue que no llega a healthy se revierte solo. Las migraciones son una tarea de un solo uso (`migrate`) que lanza el despliegue con `aws ecs run-task` antes de actualizar los servicios.
- **ALB y SSE**: `idle_timeout` de **120 s** (el de AWS es 60 s). Una `precondition` exige que sea al menos el doble del heartbeat configurado (`sse_heartbeat_interval_seconds`, 30 s).
- **Secretos**: las contraseñas de la base se generan con `random_password` y viven solo en Secrets Manager (KMS) y en el estado remoto cifrado. Las tareas las reciben como variables de entorno vía `secrets` de ECS; ningún valor aparece en el código.
- **Logs**: todos los grupos con retención definida (30 días por defecto) y cifrados con KMS.
- **Alarmas** (SNS cifrado): 5xx del ALB, CPU y memoria de cada servicio, lag del consumer (`SumOffsetLag` de MSK), mensajes en la DLQ y breakers abiertos (estas dos con métricas de la app), CPU y chequeos de estado de la instancia de TimescaleDB. **Presupuesto**: AWS Budgets al 80% real y al 100% pronosticado.
- **Sin autoscaling ni alta disponibilidad de la base**: tamaños mínimos para `dev`.

## Costo mensual estimado de `dev` (orientativo)

Precios de lista de us-east-1, sin verificar contra la calculadora de AWS; la región elegida los cambia.

| Recurso | Estimado |
|---|---|
| **MSK Serverless**: US$0,75 por hora de clúster (~US$548) + particiones (10 x US$0,0015/h, ~US$11) + datos | **~US$560** |
| NAT Gateway (1) + datos | ~US$33 |
| ALB | ~US$16 + LCU |
| Fargate: 2 tareas de 0,25 vCPU / 0,5 GiB | ~US$18 |
| EC2 t3.medium + 70 GiB de EBS gp3 + snapshots | ~US$40 |
| KMS (2 claves), Secrets Manager, ECR, CloudWatch (logs, 10 alarmas, Container Insights) | ~US$10 a 20 |
| **Total** | **~US$680 a 700** |

**El 80% del costo es MSK Serverless**, que cobra por hora de clúster aunque no haya tráfico. Es la decisión del diseño (IAM + TLS gestionados), pero para un `dev` que no corre las 24 horas conviene destruirlo fuera de horario o evaluar un MSK aprovisionado `kafka.t3.small` (del orden de US$70 a 100 al mes con 2 brokers; cifra sin verificar) o Redpanda en EC2. Hay que confirmar el presupuesto antes de cualquier `apply`.

## Requisitos para la app (los cubre `backend-engineer`)

1. **SSE** (fleet-api): enviar un heartbeat **cada 30 s como máximo**. El idle timeout del ALB es 120 s; con un heartbeat más lento el ALB corta los streams.
2. **Kafka en AWS** (ADR-004, "Pendiente"): el gateway y el processor no leen TLS ni SASL/IAM de la configuración. Se necesita firmar con IAM (por ejemplo `aws-msk-iam-sasl-signer-js`) y variables validadas con zod. Los nombres `KAFKA_TLS`, `KAFKA_AUTH=aws-iam` y `AWS_REGION` que ya inyecta Terraform son una **propuesta**: el backend decide.
3. **Métricas de la app** en el espacio de nombres `FleetTelemetry`: `DlqMessages` (Sum, mensajes publicados en `telemetry.dlq`) y `BreakerOpen` (Max, 1 con algún breaker abierto). Se pueden emitir como logs en formato EMF (CloudWatch Embedded Metric Format) por stdout, sin SDK. Hasta entonces esas dos alarmas quedan en OK.
4. **Salud del processor**: no expone HTTP. Para un `healthCheck` de ECS (y del `compose`) hace falta un `/health` o una señal equivalente.
5. **Sistema de archivos de solo lectura**: las imágenes corren con `readonlyRootFilesystem` y usuario 1000. Los servicios no deben escribir en disco (hoy loguean a stdout).
6. **TLS hacia la base**: el contenedor de TimescaleDB se alcanza por la red privada; falta confirmar que la imagen acepta TLS y fijar `sslmode` en `DATABASE_URL`.
7. **`INGEST_GATEWAY_TRUSTED_PROXY_HOPS=1`** ya está fijado: el ALB es el único proxy (ADR-004.10).

## Riesgos aceptados

- Dos reglas de salida 443 a `0.0.0.0/0` (tareas y base) hacia las APIs de AWS por NAT, y el ALB público: documentadas con `#trivy:ignore` en el código, con su motivo. La alternativa a la primera son VPC endpoints de interfaz (~US$58 al mes para 4 servicios en 2 AZ), que no eliminan el NAT que ya necesita la base (SSM, paquetes, imagen de Docker Hub).
- El bucket de estado no tiene access logs (un segundo bucket tendría el mismo hallazgo): la auditoría va por CloudTrail de la organización.
- Las contraseñas generadas por `random_password` quedan en el estado remoto (cifrado, de acceso restringido). Rotarlas implica cambiar el secreto y reiniciar los servicios.
- La instancia de la base ignora cambios de AMI y de `user_data`: se parchea en una ventana de mantenimiento, no con un `apply` accidental.
- El ALB no registra access logs (requiere otro bucket con política del servicio de ELB); se agrega con la región definida.

## Multi-cuenta con AWS Control Tower

Este diseño asume **una cuenta de AWS por ambiente** (`dev`, `staging`, `prod`). Con Control Tower:

- **Estructura**: la cuenta de gestión de la organización, las cuentas centrales `Log Archive` y `Audit` que crea Control Tower, y una OU de cargas (`Workloads`) con subunidades `NonProd` y `Prod`. Cada ambiente es una cuenta creada con Account Factory (o con Account Factory for Terraform, AFT, para que también quede como código).
- **Guardrails**: controles preventivos (SCP) como denegar regiones no aprobadas, impedir desactivar CloudTrail y exigir cifrado, y detectivos de AWS Config. Los recursos de este código ya cumplen lo que suele exigirse: cifrado en reposo con KMS, subredes privadas y sin acceso público a S3.
- **Estado y despliegue**: un bucket de estado por cuenta (como `bootstrap/`) o uno central en una cuenta de herramientas con roles entre cuentas. El CI asume por OIDC un rol por cuenta: de solo lectura para `plan` y un rol separado y con aprobación manual para `apply`, nunca llaves de acceso.
- **Costos y auditoría**: AWS Budgets por cuenta (el de `envs/dev` ya es de cuenta, por eso no filtra por etiquetas), y CloudTrail y Config centralizados en `Log Archive` y `Audit`.
- **Nuevo ambiente**: una raíz `envs/<ambiente>` que llama a los mismos módulos con otros valores (tamaños, réplicas, retenciones). Los módulos no cambian.
