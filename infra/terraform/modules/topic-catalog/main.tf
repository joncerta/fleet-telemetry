terraform {
  required_version = "~> 1.16"
}

# Fuente única de los tópicos (nombre, particiones y retención) para todas las raíces de Terraform: la raíz de plataforma la usa
# para los permisos IAM por tópico y la de tópicos para crearlos. Debe coincidir con la tabla de infra/CLAUDE.md y con
# `redpanda-init` de docker-compose.yml; si un valor cambia, se cambia en los tres sitios.
# Key de todos: vehicleId. La creación es explícita (sin autocreación de tópicos).
locals {
  day_ms = 24 * 60 * 60 * 1000

  topics = {
    "telemetry.raw" = { partitions = 3, retention_ms = 3 * local.day_ms }
    "telemetry.dlq" = { partitions = 1, retention_ms = 14 * local.day_ms }
    "vehicle.state" = { partitions = 3, retention_ms = 1 * local.day_ms }
    "fleet.alerts"  = { partitions = 3, retention_ms = 3 * local.day_ms }
  }
}

output "topics" {
  description = "Tópicos de la plataforma: nombre => { partitions, retention_ms }."
  value       = local.topics
}
