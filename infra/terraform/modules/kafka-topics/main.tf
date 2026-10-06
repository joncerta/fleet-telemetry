terraform {
  required_version = "~> 1.16"

  required_providers {
    kafka = {
      source  = "Mongey/kafka"
      version = "~> 0.13"
    }
  }
}

# Tópicos creados de forma explícita (MSK Serverless no debe depender de la autocreación). El proveedor `kafka` se configura en
# la raíz con SASL/IAM; para que Terraform llegue a los brokers debe ejecutarse DENTRO de la VPC (runner autoalojado o túnel SSM).
resource "kafka_topic" "this" {
  for_each = var.topics

  name = each.key
  # MSK Serverless fija la replicación en 3 y min.insync.replicas en 2; solo admite un subconjunto de configuraciones.
  replication_factor = 3
  partitions         = each.value.partitions

  config = {
    "retention.ms" = tostring(each.value.retention_ms)
  }
}
