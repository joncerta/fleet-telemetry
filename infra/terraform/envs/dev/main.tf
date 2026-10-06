locals {
  project     = "fleet-telemetry"
  environment = "dev"
  name        = "${local.project}-${local.environment}"

  # Servicios HTTP detrás del ALB y su puerto. Cada uno recibe su regla de SG, su target group y su healthcheck.
  http_ports   = { ingest-gateway = 4001, fleet-api = 4002, agent = 4003 }
  gateway_port = local.http_ports["ingest-gateway"]
  fleet_port   = local.http_ports["fleet-api"]
  agent_port   = local.http_ports["agent"]

  # LIVENESS, no readiness: `/health/live` no consulta la base ni Kafka. Con `/health` (readiness: 503 si falta la base), un corte breve de
  # la base haría fallar el healthcheck del contenedor Y el del target group de TODAS las tareas a la vez: ECS las mataría y el ALB
  # quedaría sin destinos, convirtiendo una degradación en una caída total. `/health` queda para compose y los e2e.
  # Mismo comando que el healthcheck de docker-compose.yml (la imagen no trae curl), con otra ruta.
  live_path = "/health/live"
  live_command = {
    for name, port in local.http_ports : name => [
      "CMD",
      "node",
      "-e",
      "fetch('http://127.0.0.1:${port}${local.live_path}',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",
    ]
  }

  # SSE: el heartbeat de fleet-api debe ser <= este intervalo (requisito para el backend); el idle timeout del ALB se deriva de él.
  # Restricción: 2 x heartbeat <= idle timeout < keep-alive de Fastify (72 s). Con 30 s: 60 <= 65 < 72.
  sse_heartbeat_max_seconds = 30
  alb_idle_timeout_seconds  = 65

  # Imágenes de los servicios que existen hoy. La web se agrega aquí y en `services` cuando exista.
  repositories = ["ingest-gateway", "processor", "fleet-api", "agent", "migrate"]
  images       = { for name in local.repositories : name => "${module.ecr.repository_urls[name]}:${var.image_tag}" }
}

module "topic_catalog" {
  source = "../../modules/topic-catalog"
}

module "kms" {
  source = "../../modules/kms"

  name = local.name
}

module "network" {
  source = "../../modules/network"

  name        = local.name
  vpc_cidr    = var.vpc_cidr
  kms_key_arn = module.kms.key_arn

  flow_log_retention_days = var.log_retention_days
}

module "ecr" {
  source = "../../modules/ecr"

  name_prefix  = local.name
  repositories = local.repositories
  kms_key_arn  = module.kms.key_arn
}

# --- Grupos de seguridad: cada origen es otro SG, salvo el ALB (443 desde internet) ---------------------------------------
resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB publico: 443 desde internet; salida solo hacia las tareas"
  vpc_id      = module.network.vpc_id
}

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "Tareas ECS: entrada solo desde el ALB"
  vpc_id      = module.network.vpc_id
}

resource "aws_security_group" "msk" {
  name        = "${local.name}-msk"
  description = "MSK Serverless: 9098 (IAM) solo desde las tareas"
  vpc_id      = module.network.vpc_id
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "TimescaleDB: 5432 solo desde las tareas"
  vpc_id      = module.network.vpc_id
}

# Único punto público del sistema: el ALB, solo en 443.
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS desde internet (el unico ingreso publico)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  for_each = local.http_ports

  security_group_id            = aws_security_group.alb.id
  description                  = "Hacia las tareas de ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  for_each = local.http_ports

  security_group_id            = aws_security_group.tasks.id
  description                  = "Trafico del ALB a ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_msk" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "Kafka (SASL/IAM sobre TLS)"
  ip_protocol                  = "tcp"
  from_port                    = 9098
  to_port                      = 9098
  referenced_security_group_id = aws_security_group.msk.id
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_database" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.database.id
}

# Las APIs de AWS (ECR, Secrets Manager, CloudWatch Logs) se alcanzan por 443 a traves del NAT: no hay endpoints de interfaz
# (cada uno cuesta ~US$7/mes por AZ). Es una salida, no una entrada: nada de internet puede iniciar conexiones hacia las tareas.
#trivy:ignore:AWS-0104 Riesgo aceptado: salida solo 443, hacia las APIs de AWS por NAT. La alternativa (VPC endpoints de interfaz para ECR api y dkr, Logs y Secrets Manager: 4 x 2 AZ, ~US$58/mes) no elimina el NAT que ya necesita la base; ver README, "Riesgos aceptados".
resource "aws_vpc_security_group_egress_rule" "tasks_https_out" {
  security_group_id = aws_security_group.tasks.id
  description       = "APIs de AWS por NAT (ECR, Secrets Manager, Logs)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "msk_from_tasks" {
  security_group_id            = aws_security_group.msk.id
  description                  = "Clientes Kafka (SASL/IAM) desde las tareas"
  ip_protocol                  = "tcp"
  from_port                    = 9098
  to_port                      = 9098
  referenced_security_group_id = aws_security_group.tasks.id
}

# --- Administración de tópicos (envs/dev-topics) ----------------------------------------------------------------------------
# El proveedor `kafka` debe llegar a los brokers desde DENTRO de la VPC. Este SG se adjunta al runner autoalojado (o a la instancia que
# haga de túnel SSM) que aplica envs/dev-topics: es el único origen, además de las tareas, admitido por el SG de MSK.
resource "aws_security_group" "topics_admin" {
  name        = "${local.name}-topics-admin"
  description = "Runner que aplica los topicos de Kafka: 9098 hacia MSK; salida 443 hacia las APIs de AWS"
  vpc_id      = module.network.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "topics_admin_to_msk" {
  security_group_id            = aws_security_group.topics_admin.id
  description                  = "Kafka (SASL/IAM sobre TLS)"
  ip_protocol                  = "tcp"
  from_port                    = 9098
  to_port                      = 9098
  referenced_security_group_id = aws_security_group.msk.id
}

#trivy:ignore:AWS-0104 Riesgo aceptado: salida solo 443 por NAT hacia las APIs de AWS (STS para firmar con IAM, SSM Parameter Store, estado en S3). Ver README, "Riesgos aceptados".
resource "aws_vpc_security_group_egress_rule" "topics_admin_https_out" {
  security_group_id = aws_security_group.topics_admin.id
  description       = "APIs de AWS por NAT (STS, SSM, S3 del estado)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "msk_from_topics_admin" {
  security_group_id            = aws_security_group.msk.id
  description                  = "Administracion de topicos (SASL/IAM) desde el runner de envs/dev-topics"
  ip_protocol                  = "tcp"
  from_port                    = 9098
  to_port                      = 9098
  referenced_security_group_id = aws_security_group.topics_admin.id
}

resource "aws_vpc_security_group_ingress_rule" "database_from_tasks" {
  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL desde las tareas"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.tasks.id
}

# La instancia de la base necesita 443 de salida: SSM Session Manager, Secrets Manager, CloudWatch Logs, paquetes del sistema y la
# imagen de Docker Hub (o de un espejo en ECR). Entrada: ninguna salvo 5432 desde las tareas.
#trivy:ignore:AWS-0104 Riesgo aceptado: salida solo 443 por NAT (SSM, Secrets Manager, Logs, paquetes e imagen de Docker Hub). Ver README, "Riesgos aceptados".
resource "aws_vpc_security_group_egress_rule" "database_https_out" {
  security_group_id = aws_security_group.database.id
  description       = "APIs de AWS, paquetes e imagen del contenedor por NAT"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# --- Datos ----------------------------------------------------------------------------------------------------------------
module "timescaledb" {
  source = "../../modules/timescaledb"

  name               = local.name
  subnet_id          = module.network.private_subnet_ids[0]
  security_group_ids = [aws_security_group.database.id]
  kms_key_arn        = module.kms.key_arn
  instance_type      = var.database_instance_type
  log_retention_days = var.log_retention_days

  credentials_version = var.credentials_version
}

module "msk" {
  source = "../../modules/msk"

  name               = local.name
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.msk.id]
}

# Los brokers se publican en SSM Parameter Store para que envs/dev-topics los lea con `data "aws_ssm_parameter"`, sin
# `terraform_remote_state` (que daría a la raíz de tópicos acceso de lectura a TODO el estado de la plataforma). Los nombres de host no
# son secretos: parámetro String estándar.
resource "aws_ssm_parameter" "bootstrap_brokers" {
  name        = "/${local.name}/msk/bootstrap-brokers-sasl-iam"
  description = "Brokers SASL/IAM de MSK Serverless (host:9098, separados por coma). Los lee envs/dev-topics."
  type        = "String"
  value       = module.msk.bootstrap_brokers_sasl_iam
}

# --- Permisos de Kafka por servicio (mínimo privilegio, por tópico y por grupo) ---------------------------------------------
locals {
  topic_arn = { for topic in keys(module.topic_catalog.topics) : topic => "${module.msk.topic_arn_prefix}/${topic}" }
}

data "aws_iam_policy_document" "gateway" {
  statement {
    sid       = "ConnectAndProduceIdempotently"
    effect    = "Allow"
    actions   = ["kafka-cluster:Connect", "kafka-cluster:WriteDataIdempotently"]
    resources = [module.msk.cluster_arn]
  }

  statement {
    sid       = "WriteRawAndDlq"
    effect    = "Allow"
    actions   = ["kafka-cluster:DescribeTopic", "kafka-cluster:WriteData"]
    resources = [local.topic_arn["telemetry.raw"], local.topic_arn["telemetry.dlq"]]
  }
}

data "aws_iam_policy_document" "processor" {
  statement {
    sid       = "ConnectAndProduceIdempotently"
    effect    = "Allow"
    actions   = ["kafka-cluster:Connect", "kafka-cluster:WriteDataIdempotently"]
    resources = [module.msk.cluster_arn]
  }

  statement {
    sid       = "ReadRaw"
    effect    = "Allow"
    actions   = ["kafka-cluster:DescribeTopic", "kafka-cluster:ReadData"]
    resources = [local.topic_arn["telemetry.raw"]]
  }

  statement {
    sid       = "WriteDlqStateAndAlerts"
    effect    = "Allow"
    actions   = ["kafka-cluster:DescribeTopic", "kafka-cluster:WriteData"]
    resources = [local.topic_arn["telemetry.dlq"], local.topic_arn["vehicle.state"], local.topic_arn["fleet.alerts"]]
  }

  statement {
    sid       = "OwnConsumerGroup"
    effect    = "Allow"
    actions   = ["kafka-cluster:AlterGroup", "kafka-cluster:DescribeGroup"]
    resources = ["${module.msk.group_arn_prefix}/${var.processor_consumer_group}"]
  }
}

# Fleet-api solo LEE vehicle.state y fleet.alerts. Cada réplica que alimenta SSE usa su propio consumer group (no comparten, regla 6 de
# CLAUDE.md): los grupos son `fleet-api-*`. PROPUESTA: el nombre real del grupo lo define el backend (todavía no consume Kafka en develop).
data "aws_iam_policy_document" "fleet_api" {
  statement {
    sid       = "Connect"
    effect    = "Allow"
    actions   = ["kafka-cluster:Connect"]
    resources = [module.msk.cluster_arn]
  }

  statement {
    sid       = "ReadStateAndAlerts"
    effect    = "Allow"
    actions   = ["kafka-cluster:DescribeTopic", "kafka-cluster:ReadData"]
    resources = [local.topic_arn["vehicle.state"], local.topic_arn["fleet.alerts"]]
  }

  statement {
    sid       = "OwnConsumerGroups"
    effect    = "Allow"
    actions   = ["kafka-cluster:AlterGroup", "kafka-cluster:DescribeGroup"]
    resources = ["${module.msk.group_arn_prefix}/fleet-api-*"]
  }
}

# Política del principal que aplica envs/dev-topics (rol del runner): crea y describe SOLO los tópicos del catálogo. Se adjunta a ese
# rol fuera de este código (el runner y su rol no se crean aquí).
data "aws_iam_policy_document" "topics_admin" {
  statement {
    sid       = "Connect"
    effect    = "Allow"
    actions   = ["kafka-cluster:Connect", "kafka-cluster:DescribeCluster"]
    resources = [module.msk.cluster_arn]
  }

  statement {
    sid    = "ManageCatalogTopics"
    effect = "Allow"
    actions = [
      "kafka-cluster:CreateTopic",
      "kafka-cluster:DescribeTopic",
      "kafka-cluster:AlterTopic",
      "kafka-cluster:DescribeTopicDynamicConfiguration",
      "kafka-cluster:AlterTopicDynamicConfiguration",
    ]
    resources = values(local.topic_arn)
  }

  statement {
    sid       = "ReadBrokersParameter"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.bootstrap_brokers.arn]
  }
}

resource "aws_iam_policy" "topics_admin" {
  name        = "${local.name}-topics-admin"
  description = "Crear y describir los topicos del catalogo y leer el parametro de brokers (runner de envs/dev-topics)."
  policy      = data.aws_iam_policy_document.topics_admin.json
}

# SESSION_SECRET de fleet-api (HMAC de la cookie, >= 32 bytes): efímero y de solo escritura, como las contraseñas de la base. Rotarlo
# (credentials_version) invalida las sesiones abiertas.
ephemeral "random_password" "session" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "session" {
  name                    = "${local.name}/app/session"
  description             = "SESSION_SECRET de fleet-api (firma de la cookie de sesion)."
  kms_key_id              = module.kms.key_arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "session" {
  secret_id                = aws_secretsmanager_secret.session.id
  secret_string_wo         = ephemeral.random_password.session.result
  secret_string_wo_version = var.credentials_version
}

# API key de Anthropic del agente. NO se genera: la aporta el humano como variable EFÍMERA (TF_VAR_anthropic_api_key) y se escribe con
# `secret_string_wo`, así que no queda en el estado ni en el plan. Solo se (re)escribe cuando sube `anthropic_api_key_version`; en los
# demás plan/apply la variable puede quedar sin valor. Secrets Manager (KMS) es su única copia.
resource "aws_secretsmanager_secret" "anthropic" {
  name                    = "${local.name}/app/anthropic"
  description             = "ANTHROPIC_API_KEY del agente (lo escribe el humano; ver el README)."
  kms_key_id              = module.kms.key_arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "anthropic" {
  secret_id                = aws_secretsmanager_secret.anthropic.id
  secret_string_wo         = var.anthropic_api_key
  secret_string_wo_version = var.anthropic_api_key_version
}

# --- Servicios en Fargate, detrás del ALB (solo 443) ----------------------------------------------------------------------
locals {
  # Nombres propuestos para la autenticación de Kafka en AWS: el backend los define (ADR-004, "Pendiente": TLS y SASL/IAM de MSK).
  kafka_aws_environment = {
    KAFKA_BROKERS       = module.msk.bootstrap_brokers_sasl_iam
    KAFKA_TLS           = "true"
    KAFKA_AUTH          = "aws-iam"
    AWS_REGION          = var.aws_region
    LOG_LEVEL           = "info"
    NODE_ENV            = "production"
    SHUTDOWN_TIMEOUT_MS = "15000"
  }
}

module "services" {
  source = "../../modules/ecs-services"

  name                    = local.name
  vpc_id                  = module.network.vpc_id
  public_subnet_ids       = module.network.public_subnet_ids
  private_subnet_ids      = module.network.private_subnet_ids
  alb_security_group_id   = aws_security_group.alb.id
  tasks_security_group_id = aws_security_group.tasks.id
  certificate_arn         = var.certificate_arn
  kms_key_arn             = module.kms.key_arn
  ecr_repository_arns     = values(module.ecr.repository_arns)
  log_retention_days      = var.log_retention_days

  # REQUISITO PARA EL BACKEND (fleet-api): el heartbeat del SSE debe enviarse cada <= 30 s. El idle timeout del ALB (65 s) cumple
  # 2 x 30 <= 65 y queda por debajo del keep-alive de Fastify (72 s): dos precondiciones del módulo lo garantizan.
  sse_heartbeat_interval_seconds     = local.sse_heartbeat_max_seconds
  alb_idle_timeout_seconds           = local.alb_idle_timeout_seconds
  backend_keep_alive_timeout_seconds = 72

  services = {
    ingest-gateway = {
      image         = local.images["ingest-gateway"]
      cpu           = 256
      memory        = 512
      desired_count = var.gateway_desired_count
      environment = merge(local.kafka_aws_environment, {
        INGEST_GATEWAY_HOST = "0.0.0.0"
        INGEST_GATEWAY_PORT = tostring(local.gateway_port)
        # El ALB es el único proxy delante del gateway (ADR-004.10): con 1 salto la IP del cliente sale de X-Forwarded-For.
        # Es seguro porque el SG de las tareas solo admite tráfico del ALB.
        INGEST_GATEWAY_TRUSTED_PROXY_HOPS = "1"
      })
      secrets              = { DATABASE_URL = "${module.timescaledb.secret_arns["app"]}:app_url::" }
      task_policy_json     = data.aws_iam_policy_document.gateway.json
      container_port       = local.gateway_port
      health_check_path    = local.live_path
      health_check_command = local.live_command["ingest-gateway"]
      listener_priority    = 100
      path_patterns        = ["/v1/telemetry/*"]
    }

    fleet-api = {
      image         = local.images["fleet-api"]
      cpu           = 256
      memory        = 512
      desired_count = var.fleet_api_desired_count
      environment = merge(local.kafka_aws_environment, {
        FLEET_API_HOST = "0.0.0.0"
        FLEET_API_PORT = tostring(local.fleet_port)
        # El ALB es el único proxy delante de fleet-api (el SG de las tareas solo admite tráfico del ALB).
        FLEET_API_TRUSTED_PROXY_HOPS = "1"
        # El ALB termina TLS: la cookie de sesión debe ser Secure.
        FLEET_API_COOKIE_SECURE = "true"
        FLEET_API_CORS_ORIGINS  = join(",", var.fleet_api_cors_origins)
        # Latido a la mitad del máximo: con el idle timeout del ALB caben varios latidos perdidos.
        SSE_HEARTBEAT_MS = tostring(local.sse_heartbeat_max_seconds * 1000 / 2)
      })
      secrets = {
        DATABASE_URL   = "${module.timescaledb.secret_arns["app"]}:app_url::"
        SESSION_SECRET = aws_secretsmanager_secret.session.arn
      }
      task_policy_json     = data.aws_iam_policy_document.fleet_api.json
      container_port       = local.fleet_port
      health_check_path    = local.live_path
      health_check_command = local.live_command["fleet-api"]
      # Después de la regla del gateway (100): el resto de /v1/* (auth, dispositivos, lecturas y stream SSE) es de fleet-api.
      listener_priority = 200
      path_patterns     = ["/v1/*"]
    }

    # El agente no usa Kafka ni la base: llama a fleet-api con la cookie del usuario y a la API del modelo (443 por NAT). Su tarea tiene rol
    # propio sin permisos AWS (sin task_policy_json) y su rol de ejecución solo lee SESSION_SECRET y ANTHROPIC_API_KEY.
    agent = {
      image         = local.images["agent"]
      cpu           = 256
      memory        = 512
      desired_count = var.agent_desired_count
      environment = {
        AGENT_HOST = "0.0.0.0"
        AGENT_PORT = tostring(local.agent_port)
        # La red de las tareas no tiene ruta interna hacia fleet-api: la llamada sale por el NAT y entra por el ALB (URL pública).
        FLEET_API_URL        = var.agent_fleet_api_url
        AGENT_CORS_ORIGINS   = join(",", var.fleet_api_cors_origins)
        AGENT_MODEL_PROVIDER = "anthropic"
        # El ALB es el único proxy delante del agente (el SG de las tareas solo admite tráfico del ALB).
        AGENT_TRUSTED_PROXY_HOPS = "1"
        LOG_LEVEL                = "info"
        NODE_ENV                 = "production"
        SHUTDOWN_TIMEOUT_MS      = "15000"
      }
      secrets = {
        SESSION_SECRET    = aws_secretsmanager_secret.session.arn
        ANTHROPIC_API_KEY = aws_secretsmanager_secret.anthropic.arn
      }
      container_port       = local.agent_port
      health_check_path    = local.live_path
      health_check_command = local.live_command["agent"]
      # Antes que el /v1/* de fleet-api (200): /v1/chat es del agente. Después del gateway (100), que no se solapa.
      listener_priority = 150
      path_patterns     = ["/v1/chat", "/v1/chat/*"]
    }

    processor = {
      image         = local.images["processor"]
      cpu           = 256
      memory        = 512
      desired_count = var.processor_desired_count
      environment = merge(local.kafka_aws_environment, {
        PROCESSOR_CONSUMER_GROUP = var.processor_consumer_group
      })
      secrets          = { DATABASE_URL = "${module.timescaledb.secret_arns["app"]}:app_url::" }
      task_policy_json = data.aws_iam_policy_document.processor.json
    }
  }

  # Migraciones: tarea de un solo uso que lanza el despliegue (`aws ecs run-task`) antes de actualizar los servicios.
  jobs = {
    migrate = {
      image  = local.images["migrate"]
      cpu    = 256
      memory = 512
      environment = {
        LOG_LEVEL = "info"
      }
      secrets = {
        # Único consumidor del secreto db/admin (el superusuario): ninguna otra tarea tiene permiso para leerlo.
        DATABASE_ADMIN_URL = "${module.timescaledb.secret_arns["admin"]}:admin_url::"
        FLEET_APP_PASSWORD = "${module.timescaledb.secret_arns["admin"]}:fleet_app_password::"
        FLEET_RO_PASSWORD  = "${module.timescaledb.secret_arns["admin"]}:fleet_ro_password::"
      }
    }
  }
}

# --- Alarmas y presupuesto ------------------------------------------------------------------------------------------------
module "observability" {
  source = "../../modules/observability"

  name                 = local.name
  kms_key_arn          = module.kms.key_arn
  alarm_emails         = var.alarm_emails
  alb_arn_suffix       = module.services.alb_arn_suffix
  cluster_name         = module.services.cluster_name
  service_names        = module.services.service_names
  msk_cluster_name     = module.msk.cluster_name
  consumer_group       = var.processor_consumer_group
  database_instance_id = module.timescaledb.instance_id
}

# Presupuesto mensual de la cuenta del ambiente (con una cuenta por ambiente, ver README, equivale al del ambiente).
resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_emails
  }
}
