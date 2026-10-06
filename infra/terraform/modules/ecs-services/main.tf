terraform {
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }
}

data "aws_region" "current" {}

locals {
  # Servicios con puerto = detrás del ALB; sin puerto (el processor) = solo consumen de Kafka.
  http_services = { for name, service in var.services : name => service if service.container_port != null }
  all_tasks     = merge(var.services, var.jobs)
}

# --- Clúster --------------------------------------------------------------------------------------------------------------
resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# --- Logs (retención definida, cifrados con KMS) ------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "task" {
  for_each = local.all_tasks

  name              = "/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

# --- IAM: rol de ejecución (compartido: baja imágenes, escribe logs, lee los secretos listados) -------------------------
data "aws_iam_policy_document" "tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "execution" {
  # GetAuthorizationToken no admite recursos específicos: AWS exige "*" (solo entrega un token de login a ECR).
  statement {
    sid       = "EcrLogin"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PullFromOwnRepositories"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = var.ecr_repository_arns
  }

  statement {
    sid       = "WriteTaskLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [for group in aws_cloudwatch_log_group.task : "${group.arn}:*"]
  }

  statement {
    sid       = "ReadTaskSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.secret_arns
  }

  statement {
    sid       = "DecryptSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.tasks_assume.json
}

resource "aws_iam_role_policy" "execution" {
  name   = "pull-logs-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# --- IAM: un rol de tarea por servicio, con la política mínima que declara la raíz (Kafka por tópico, etc.) ----------------
resource "aws_iam_role" "task" {
  for_each = { for name, task in local.all_tasks : name => task if task.task_policy_json != null }

  name               = "${var.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.tasks_assume.json
}

resource "aws_iam_role_policy" "task" {
  for_each = aws_iam_role.task

  name   = "least-privilege"
  role   = each.value.id
  policy = local.all_tasks[each.key].task_policy_json
}

# --- Definiciones de tarea (servicios y jobs de un solo uso, como las migraciones) -------------------------------------
resource "aws_ecs_task_definition" "this" {
  for_each = local.all_tasks

  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = try(aws_iam_role.task[each.key].arn, null)

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    merge(
      {
        name      = each.key
        image     = each.value.image
        essential = true

        # Sistema de archivos raíz de solo lectura y sin privilegios: los servicios solo escriben en /tmp si lo necesitan.
        readonlyRootFilesystem = true
        user                   = "1000:1000"

        environment = [for key, value in each.value.environment : { name = key, value = value }]
        secrets     = [for key, value_from in each.value.secrets : { name = key, valueFrom = value_from }]

        logConfiguration = {
          logDriver = "awslogs"
          options = {
            "awslogs-group"         = aws_cloudwatch_log_group.task[each.key].name
            "awslogs-region"        = data.aws_region.current.region
            "awslogs-stream-prefix" = each.key
          }
        }
        stopTimeout = 30
      },
      each.value.command == null ? {} : { command = each.value.command },
      each.value.container_port == null ? {} : { portMappings = [{ containerPort = each.value.container_port, protocol = "tcp" }] },
      each.value.health_check_command == null ? {} : {
        healthCheck = {
          command     = each.value.health_check_command
          interval    = 15
          timeout     = 5
          retries     = 3
          startPeriod = 20
        }
      },
    )
  ])
}

# --- ALB público, solo en 443 ---------------------------------------------------------------------------------------------
#trivy:ignore:AWS-0053 El ALB es el unico punto publico del sistema, por diseno (solo 443; el SG lo limita y todo lo demas va en subredes privadas).
resource "aws_lb" "this" {
  name               = var.name
  load_balancer_type = "application"
  internal           = false
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids

  drop_invalid_header_fields = true
  enable_deletion_protection = var.alb_deletion_protection

  # SSE: el ALB cierra una conexión sin tráfico tras este tiempo. Debe superar el intervalo del heartbeat del SSE del backend
  # (con holgura de al menos 2 latidos perdidos). REQUISITO PARA EL BACKEND: heartbeat cada <= sse_heartbeat_interval_seconds.
  idle_timeout = var.alb_idle_timeout_seconds

  lifecycle {
    precondition {
      condition     = var.alb_idle_timeout_seconds >= 2 * var.sse_heartbeat_interval_seconds
      error_message = "alb_idle_timeout_seconds debe ser al menos el doble de sse_heartbeat_interval_seconds, o el ALB cortará los streams SSE."
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  # Lo que ninguna regla reconoce no llega a ningún servicio.
  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":{\"code\":\"not_found\",\"message\":\"Ruta desconocida.\"}}"
      status_code  = "404"
    }
  }
}

resource "aws_lb_target_group" "this" {
  for_each = local.http_services

  # El nombre de un target group admite 32 caracteres como máximo.
  name                 = substr("${var.name}-${each.key}", 0, 32)
  port                 = each.value.container_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = each.value.health_check_path
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener_rule" "this" {
  for_each = local.http_services

  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.listener_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[each.key].arn
  }

  condition {
    path_pattern {
      values = each.value.path_patterns
    }
  }
}

# --- Servicios ------------------------------------------------------------------------------------------------------------
resource "aws_ecs_service" "this" {
  for_each = var.services

  name            = each.key
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"

  # Un despliegue que no llega a healthy se revierte solo.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = each.value.container_port == null ? null : 30

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.tasks_security_group_id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.container_port == null ? [] : [1]

    content {
      target_group_arn = aws_lb_target_group.this[each.key].arn
      container_name   = each.key
      container_port   = each.value.container_port
    }
  }

  depends_on = [aws_lb_listener_rule.this]
}
