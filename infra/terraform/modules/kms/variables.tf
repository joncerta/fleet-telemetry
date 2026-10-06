variable "name" {
  description = "Nombre base de la clave (prefijo del ambiente, p. ej. fleet-telemetry-dev)."
  type        = string
}

variable "deletion_window_days" {
  description = "Días de espera antes de borrar la clave (7 a 30)."
  type        = number
  default     = 14

  validation {
    condition     = var.deletion_window_days >= 7 && var.deletion_window_days <= 30
    error_message = "deletion_window_days debe estar entre 7 y 30."
  }
}
