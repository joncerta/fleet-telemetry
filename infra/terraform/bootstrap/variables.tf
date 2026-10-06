variable "aws_region" {
  description = "Región del bucket de estado. Decisión pendiente."
  type        = string
}

variable "owner" {
  description = "Dueño (etiqueta `owner`)."
  type        = string
}

variable "cost_center" {
  description = "Centro de costos (etiqueta `cost-center`)."
  type        = string
}

variable "noncurrent_version_retention_days" {
  description = "Días que se conservan las versiones anteriores del estado."
  type        = number
  default     = 90
}
