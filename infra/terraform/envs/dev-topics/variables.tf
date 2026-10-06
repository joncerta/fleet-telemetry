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

variable "brokers_parameter_name" {
  description = "Nombre del parámetro de SSM con los brokers SASL/IAM: la salida bootstrap_brokers_parameter_name de envs/dev."
  type        = string
}
