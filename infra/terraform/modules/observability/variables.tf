variable "name" {
  description = "Nombre base (prefijo del ambiente)."
  type        = string
}

variable "kms_key_arn" {
  description = "Clave KMS del tema SNS de alarmas."
  type        = string
}

variable "alarm_emails" {
  description = "Correos suscritos al tema de alarmas (cada uno debe confirmar la suscripción). Vacío = sin suscriptores."
  type        = list(string)
  default     = []
}

variable "alb_arn_suffix" {
  description = "Sufijo del ARN del ALB."
  type        = string
}

variable "cluster_name" {
  description = "Nombre del clúster ECS."
  type        = string
}

variable "service_names" {
  description = "Servicios ECS que reciben alarmas de CPU y memoria."
  type        = list(string)
}

variable "msk_cluster_name" {
  description = "Nombre del clúster MSK Serverless."
  type        = string
}

variable "consumer_group" {
  description = "Consumer group del processor (PROCESSOR_CONSUMER_GROUP)."
  type        = string
  default     = "processor"
}

variable "lag_topic" {
  description = "Tópico cuyo lag se vigila."
  type        = string
  default     = "telemetry.raw"
}

variable "database_instance_id" {
  description = "ID de la instancia EC2 de TimescaleDB."
  type        = string
}

variable "custom_metric_namespace" {
  description = "Espacio de nombres de las métricas personalizadas que emite la app (DlqMessages, BreakerOpen)."
  type        = string
  default     = "FleetTelemetry"
}

variable "alb_5xx_threshold" {
  description = "5xx tolerados en 5 minutos antes de alarmar."
  type        = number
  default     = 5
}

variable "cpu_threshold_percent" {
  description = "Umbral de CPU (%)."
  type        = number
  default     = 80
}

variable "memory_threshold_percent" {
  description = "Umbral de memoria (%)."
  type        = number
  default     = 80
}

variable "consumer_lag_threshold" {
  description = "Mensajes de lag tolerados en el consumer antes de alarmar."
  type        = number
  default     = 5000
}

variable "dlq_messages_threshold" {
  description = "Mensajes en la DLQ tolerados en 5 minutos (0 = cualquiera alarma)."
  type        = number
  default     = 0
}
