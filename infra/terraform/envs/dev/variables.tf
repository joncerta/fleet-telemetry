# Sin valores por defecto para lo que depende de una decisión del equipo (región, dueño, centro de costos, presupuesto,
# certificado): el plan falla hasta que se definan. Se pasan con un `terraform.tfvars` local (no se commitea; ver
# terraform.tfvars.example) o con variables TF_VAR_*.

variable "aws_region" {
  description = "Región de AWS del ambiente. Decisión pendiente: debe tener MSK Serverless."
  type        = string
}

variable "owner" {
  description = "Dueño del ambiente (etiqueta `owner`)."
  type        = string
}

variable "cost_center" {
  description = "Centro de costos (etiqueta `cost-center`)."
  type        = string
}

variable "image_tag" {
  description = "Tag de las imágenes en ECR (p. ej. el SHA del commit). Los tags son inmutables: un tag nuevo por despliegue."
  type        = string

  validation {
    condition     = var.image_tag != "latest"
    error_message = "Usa un tag inmutable (SHA del commit), nunca latest."
  }
}

variable "certificate_arn" {
  description = "ARN del certificado ACM para el listener 443 del ALB (misma región). Requiere un dominio: decisión pendiente."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Presupuesto mensual del ambiente, en USD. Alarma al 80% real y al 100% pronosticado. Decisión pendiente."
  type        = number

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "El presupuesto mensual debe ser mayor que 0."
  }
}

variable "budget_emails" {
  description = "Correos que reciben las alertas de presupuesto (al menos uno)."
  type        = list(string)

  validation {
    condition     = length(var.budget_emails) >= 1
    error_message = "Define al menos un correo para las alertas de presupuesto."
  }
}

variable "alarm_emails" {
  description = "Correos suscritos al tema de alarmas operativas (deben confirmar la suscripción)."
  type        = list(string)
  default     = []
}

variable "vpc_cidr" {
  description = "CIDR /16 de la VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "log_retention_days" {
  description = "Retención de todos los grupos de logs, en días (valor admitido por CloudWatch Logs)."
  type        = number
  default     = 30
}

variable "gateway_desired_count" {
  description = "Réplicas del ingest-gateway."
  type        = number
  default     = 1
}

variable "processor_desired_count" {
  description = "Réplicas del processor (como mucho una por partición de telemetry.raw, 3)."
  type        = number
  default     = 1
}

variable "database_instance_type" {
  description = "Tipo de instancia EC2 de TimescaleDB."
  type        = string
  default     = "t3.medium"
}

variable "processor_consumer_group" {
  description = "Consumer group del processor (PROCESSOR_CONSUMER_GROUP): también el que vigila la alarma de lag."
  type        = string
  default     = "processor"
}

variable "fleet_api_desired_count" {
  description = "Réplicas de fleet-api. En el primer despliegue va en 0 junto con el gateway y el processor (ver el README, orden de despliegue)."
  type        = number
  default     = 1
}

variable "fleet_api_cors_origins" {
  description = "Orígenes de la web autorizados a llamar a fleet-api con la cookie de sesión (https://host[:puerto], sin ruta ni comodín). Decisión pendiente: depende del dominio de la web."
  type        = list(string)

  validation {
    condition     = length(var.fleet_api_cors_origins) >= 1 && alltrue([for origin in var.fleet_api_cors_origins : can(regex("^https://[^/*]+$", origin))])
    error_message = "Cada origen debe ser https://host[:puerto], sin ruta ni comodín."
  }
}

variable "agent_desired_count" {
  description = "Réplicas del agente. En el primer despliegue va en 0 (hasta escribir ANTHROPIC_API_KEY y tener la URL pública de fleet-api; ver el README)."
  type        = number
  default     = 1
}

variable "agent_fleet_api_url" {
  description = "URL base HTTPS de fleet-api que usa el agente (la del ALB: https://<dominio>, sin ruta ni credenciales). Decisión pendiente: depende del dominio del certificado."
  type        = string

  validation {
    condition     = can(regex("^https://[^/@*]+$", var.agent_fleet_api_url))
    error_message = "Debe ser https://host[:puerto], sin ruta, credenciales ni comodín."
  }
}

variable "anthropic_api_key" {
  description = "ANTHROPIC_API_KEY del agente. EFÍMERA y sensible: no queda en el estado ni en el plan. Pásala solo al crear o rotar la clave (TF_VAR_anthropic_api_key) junto con anthropic_api_key_version; nunca en un tfvars."
  type        = string
  default     = null
  sensitive   = true
  ephemeral   = true
}

variable "anthropic_api_key_version" {
  description = "Versión del secreto de la API key (entero >= 1). Subirla reescribe el valor de anthropic_api_key en Secrets Manager."
  type        = number
  default     = 1

  validation {
    condition     = var.anthropic_api_key_version >= 1 && var.anthropic_api_key_version == floor(var.anthropic_api_key_version)
    error_message = "anthropic_api_key_version debe ser un entero >= 1."
  }
}

variable "credentials_version" {
  description = "Versión de las credenciales generadas (contraseñas de la base y SESSION_SECRET), entero entre 1 y 99. Subirla las reescribe en Secrets Manager (rotación); ver el README."
  type        = number
  default     = 1

  validation {
    condition     = var.credentials_version >= 1 && var.credentials_version == floor(var.credentials_version) && var.credentials_version < 100
    error_message = "credentials_version debe ser un entero entre 1 y 99."
  }
}
