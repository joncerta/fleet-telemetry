terraform {
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }
}

# Alarmas mínimas: 5xx del ALB, lag del consumer, mensajes en la DLQ, breakers abiertos, CPU y memoria de los servicios, y la
# salud de la instancia de TimescaleDB. Todas notifican a un tema SNS cifrado con KMS.
#
# Las de la DLQ y los breakers usan métricas PERSONALIZADAS (espacio de nombres `var.custom_metric_namespace`) que la app debe
# emitir; hasta que lo haga, `treat_missing_data = notBreaching` las deja en OK (ver "Requisitos para la app" en el README).

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = var.kms_key_arn
}

resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alarm_emails)

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

# --- ALB: 5xx (los del balanceador y los de los destinos) -----------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-alb-5xx"
  alarm_description   = "El ALB devolvió más de ${var.alb_5xx_threshold} respuestas 5xx en 5 minutos."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alb_5xx_threshold
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "total"
    expression  = "elb + target"
    label       = "5xx totales"
    return_data = true
  }

  metric_query {
    id = "elb"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    }
  }

  metric_query {
    id = "target"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    }
  }
}

# --- ECS: CPU y memoria por servicio -------------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "service_cpu" {
  for_each = toset(var.service_names)

  alarm_name          = "${var.name}-${each.value}-cpu"
  alarm_description   = "CPU de ${each.value} por encima de ${var.cpu_threshold_percent}% durante 10 minutos."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = each.value }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.cpu_threshold_percent
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "service_memory" {
  for_each = toset(var.service_names)

  alarm_name          = "${var.name}-${each.value}-memory"
  alarm_description   = "Memoria de ${each.value} por encima de ${var.memory_threshold_percent}% durante 10 minutos."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = each.value }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.memory_threshold_percent
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- Kafka: lag del consumer del processor (métrica AWS/Kafka de MSK Serverless) ---------------------------------------
resource "aws_cloudwatch_metric_alarm" "consumer_lag" {
  alarm_name          = "${var.name}-consumer-lag"
  alarm_description   = "El grupo ${var.consumer_group} acumula más de ${var.consumer_lag_threshold} mensajes sin consumir en ${var.lag_topic}."
  namespace           = "AWS/Kafka"
  metric_name         = "SumOffsetLag"
  dimensions          = { "Cluster Name" = var.msk_cluster_name, "Consumer Group" = var.consumer_group, Topic = var.lag_topic }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.consumer_lag_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- Métricas de la app: DLQ y breakers abiertos (la app debe emitirlas; ver README) ------------------------------------
resource "aws_cloudwatch_metric_alarm" "dlq_messages" {
  alarm_name          = "${var.name}-dlq-messages"
  alarm_description   = "Llegaron más de ${var.dlq_messages_threshold} mensajes a telemetry.dlq en 5 minutos (métrica DlqMessages de la app)."
  namespace           = var.custom_metric_namespace
  metric_name         = "DlqMessages"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.dlq_messages_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "breakers_open" {
  alarm_name          = "${var.name}-breakers-open"
  alarm_description   = "Hay al menos un circuit breaker abierto (métrica BreakerOpen de la app)."
  namespace           = var.custom_metric_namespace
  metric_name         = "BreakerOpen"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- TimescaleDB (EC2): CPU y chequeos de estado ---------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "database_cpu" {
  alarm_name          = "${var.name}-timescaledb-cpu"
  alarm_description   = "CPU de la instancia de TimescaleDB por encima de ${var.cpu_threshold_percent}% durante 10 minutos."
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { InstanceId = var.database_instance_id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.cpu_threshold_percent
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "database_status" {
  alarm_name          = "${var.name}-timescaledb-status-check"
  alarm_description   = "La instancia de TimescaleDB falló un chequeo de estado de EC2."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = var.database_instance_id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
