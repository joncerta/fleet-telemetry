locals {
  project     = "fleet-telemetry"
  environment = "dev"
  name        = "${local.project}-${local.environment}"

  gateway_port = 4001
  # Mismo comando que el healthcheck de docker-compose.yml: la imagen no trae curl.
  gateway_health_command = [
    "CMD",
    "node",
    "-e",
    "fetch('http://127.0.0.1:${local.gateway_port}/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",
  ]

  # Imágenes de los servicios que existen hoy. fleet-api, agent y web se agregan aquí y en `services` cuando existan.
  repositories = ["ingest-gateway", "processor", "migrate"]
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
  security_group_id            = aws_security_group.alb.id
  description                  = "Hacia las tareas del gateway"
  ip_protocol                  = "tcp"
  from_port                    = local.gateway_port
  to_port                      = local.gateway_port
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "Trafico del ALB al gateway"
  ip_protocol                  = "tcp"
  from_port                    = local.gateway_port
  to_port                      = local.gateway_port
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
}

module "msk" {
  source = "../../modules/msk"

  name               = local.name
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.msk.id]
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
  secret_arns             = [module.timescaledb.secret_arn]
  log_retention_days      = var.log_retention_days

  # REQUISITO PARA EL BACKEND (fleet-api): el heartbeat del SSE debe enviarse cada <= 30 s. El idle timeout del ALB (120 s por
  # defecto en este módulo, 60 s en AWS) es el mínimo seguro para ese intervalo; la precondición del módulo exige >= 2 latidos.
  sse_heartbeat_interval_seconds = 30
  alb_idle_timeout_seconds       = 120

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
      secrets              = { DATABASE_URL = "${module.timescaledb.secret_arn}:app_url::" }
      task_policy_json     = data.aws_iam_policy_document.gateway.json
      container_port       = local.gateway_port
      health_check_path    = "/health"
      health_check_command = local.gateway_health_command
      listener_priority    = 100
      path_patterns        = ["/v1/telemetry/*"]
    }

    processor = {
      image         = local.images["processor"]
      cpu           = 256
      memory        = 512
      desired_count = var.processor_desired_count
      environment = merge(local.kafka_aws_environment, {
        PROCESSOR_CONSUMER_GROUP = var.processor_consumer_group
      })
      secrets          = { DATABASE_URL = "${module.timescaledb.secret_arn}:app_url::" }
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
        DATABASE_ADMIN_URL = "${module.timescaledb.secret_arn}:admin_url::"
        FLEET_APP_PASSWORD = "${module.timescaledb.secret_arn}:fleet_app_password::"
        FLEET_RO_PASSWORD  = "${module.timescaledb.secret_arn}:fleet_ro_password::"
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
