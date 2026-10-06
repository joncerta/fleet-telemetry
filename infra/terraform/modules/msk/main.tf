terraform {
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }
}

# MSK Serverless: autenticación IAM (SASL/IAM, puerto 9098) y TLS siempre activo en tránsito. No admite CMK ni logs de brokers:
# el cifrado en reposo es con la clave que administra AWS. Los tópicos NO se crean aquí: el proveedor de AWS no tiene recurso
# para ellos; los crea el módulo kafka-topics (raíz envs/dev-topics), con particiones y retención explícitas.
resource "aws_msk_serverless_cluster" "this" {
  cluster_name = var.name

  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = var.security_group_ids
  }

  client_authentication {
    sasl {
      iam {
        enabled = true
      }
    }
  }
}

locals {
  # arn:aws:kafka:<región>:<cuenta>:cluster/<nombre>/<uuid>. Los ARN de tópicos y grupos usan el mismo sufijo.
  topic_arn_prefix = replace(aws_msk_serverless_cluster.this.arn, ":cluster/", ":topic/")
  group_arn_prefix = replace(aws_msk_serverless_cluster.this.arn, ":cluster/", ":group/")
}
