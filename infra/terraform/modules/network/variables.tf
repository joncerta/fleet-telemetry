variable "name" {
  description = "Nombre base de la red (prefijo del ambiente)."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR de la VPC. Debe ser /16 (las subredes /24 se derivan de él)."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && endswith(var.vpc_cidr, "/16")
    error_message = "vpc_cidr debe ser un CIDR válido de tamaño /16."
  }
}

variable "az_count" {
  description = "Zonas de disponibilidad a usar (2 o 3). MSK Serverless y el ALB exigen al menos 2."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count debe ser 2 o 3."
  }
}

variable "enable_nat_gateway" {
  description = "Crea NAT para la salida a internet de las subredes privadas (imágenes, SSM, Secrets Manager)."
  type        = bool
  default     = true
}

variable "single_nat_gateway" {
  description = "Un solo NAT para todas las AZ (más barato, sin alta disponibilidad de salida). false = un NAT por AZ."
  type        = bool
  default     = true
}

variable "kms_key_arn" {
  description = "Clave KMS que cifra el grupo de logs de los flow logs."
  type        = string
}

variable "flow_log_retention_days" {
  description = "Retención de los flow logs en días (valor admitido por CloudWatch Logs)."
  type        = number
  default     = 30
}
