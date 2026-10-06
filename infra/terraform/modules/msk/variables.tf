variable "name" {
  description = "Nombre del clúster MSK Serverless."
  type        = string
}

variable "subnet_ids" {
  description = "Subredes privadas (al menos 2 AZ distintas)."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "MSK Serverless exige al menos 2 subredes en AZ distintas."
  }
}

variable "security_group_ids" {
  description = "Grupos de seguridad del clúster (el origen permitido en 9098 se define en la raíz, por SG de origen)."
  type        = list(string)
}
