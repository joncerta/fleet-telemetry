variable "name_prefix" {
  description = "Prefijo de los repositorios (p. ej. fleet-telemetry-dev). El repositorio queda como <prefijo>/<nombre>."
  type        = string
}

variable "repositories" {
  description = "Nombres de las imágenes (un repositorio por cada una)."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "Clave KMS que cifra las imágenes."
  type        = string
}

variable "keep_tagged_images" {
  description = "Imágenes con tag que se conservan por repositorio."
  type        = number
  default     = 10
}

variable "untagged_expire_days" {
  description = "Días tras los que se borran las imágenes sin tag."
  type        = number
  default     = 7
}
