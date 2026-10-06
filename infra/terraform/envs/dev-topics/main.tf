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

# La región y los brokers salen del estado de la plataforma: sin valores duplicados entre raíces.
data "terraform_remote_state" "platform" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = var.platform_state_key
    region = var.state_region
  }
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

# MSK Serverless solo acepta SASL/IAM sobre TLS. Las credenciales AWS salen del entorno (OIDC o SSO); el principal necesita
# kafka-cluster:* sobre los tópicos que crea (rol de administración, distinto de los roles de los servicios).
provider "kafka" {
  bootstrap_servers = split(",", data.terraform_remote_state.platform.outputs.bootstrap_brokers_sasl_iam)
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
