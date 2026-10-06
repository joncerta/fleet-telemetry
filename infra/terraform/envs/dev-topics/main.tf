terraform {
  required_version = "~> 1.16"

  required_providers {
    kafka = {
      source  = "Mongey/kafka"
      version = "~> 0.13"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }

  # Estado propio, aparte de la plataforma: el proveedor `kafka` necesita llegar a los brokers y por eso esta raíz se aplica
  # desde DENTRO de la VPC (runner autoalojado, o un túnel SSM hacia la VPC), no desde el runner público de CI.
  # Mismo patrón de backend parcial que envs/dev: terraform init -backend-config=backend.hcl (clave distinta, ver el ejemplo).
  backend "s3" {}
}

# Los brokers los publica envs/dev en SSM Parameter Store (String, no es un secreto). Se leen con un data source y NO con
# `terraform_remote_state`: este último daría a esta raíz (y a su runner, dentro de la VPC) lectura de TODO el estado de la plataforma.
# El principal que aplica esta raíz solo necesita ssm:GetParameter sobre ese parámetro (política `topics_admin` de envs/dev).
data "aws_ssm_parameter" "bootstrap_brokers" {
  name = var.brokers_parameter_name
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project       = "fleet-telemetry"
      env           = "dev"
      owner         = var.owner
      "cost-center" = var.cost_center
      managed-by    = "terraform"
    }
  }
}

# MSK Serverless solo acepta SASL/IAM sobre TLS. Las credenciales AWS salen del entorno (OIDC o SSO); el principal necesita la política
# `topics_admin` de envs/dev (rol de administración, distinto de los roles de los servicios) y el runner, su SG `topics_admin`.
provider "kafka" {
  bootstrap_servers = split(",", data.aws_ssm_parameter.bootstrap_brokers.value)
  tls_enabled       = true
  sasl_mechanism    = "aws-iam"
  sasl_aws_region   = var.aws_region
}

module "topic_catalog" {
  source = "../../modules/topic-catalog"
}

module "topics" {
  source = "../../modules/kafka-topics"

  topics = module.topic_catalog.topics
}

output "topic_names" {
  description = "Tópicos creados."
  value       = module.topics.topic_names
}
