variable "aws_region" {
  description = "Región de AWS del ambiente (la misma que envs/dev). Decisión pendiente."
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

variable "state_bucket" {
  description = "Bucket S3 del estado remoto (el que crea bootstrap/)."
  type        = string
}

variable "state_region" {
  description = "Región del bucket de estado."
  type        = string
}

variable "platform_state_key" {
  description = "Clave del estado de la plataforma (envs/dev) dentro del bucket."
  type        = string
  default     = "fleet-telemetry/dev/platform.tfstate"
}
