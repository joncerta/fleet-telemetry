terraform {
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }

  # Estado remoto en S3, cifrado, versionado y con bloqueo nativo (`use_lockfile`, Terraform >= 1.10: sin tabla de DynamoDB).
  # La configuración concreta (bucket, región, clave KMS) NO va en el repositorio: se pasa al inicializar,
  #   terraform init -backend-config=backend.hcl
  # a partir de backend.hcl.example (backend.hcl no se commitea). El bucket lo crea ../../bootstrap.
  backend "s3" {}
}
