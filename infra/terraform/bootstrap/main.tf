terraform {
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }

  # EXCEPCIÓN DOCUMENTADA al "nunca estado local": esta raíz crea el bucket que guardará el estado de las demás, así que
  # arranca sin backend (problema del huevo y la gallina). Se aplica UNA vez por cuenta con un administrador. Después se migra su
  # propio estado al bucket que acaba de crear: añade un bloque `backend "s3" {}` con el patrón de ../envs/dev/backend.hcl.example
  # (clave fleet-telemetry/bootstrap.tfstate) y ejecuta `terraform init -migrate-state`. Mientras tanto el .tfstate local está
  # ignorado por git y no contiene secretos (solo ARN).
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project       = "fleet-telemetry"
      env           = "shared"
      owner         = var.owner
      "cost-center" = var.cost_center
      managed-by    = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  # El nombre de un bucket es global: la cuenta lo hace único sin pedir un valor.
  bucket_name = "fleet-telemetry-tfstate-${data.aws_caller_identity.current.account_id}"
}

data "aws_iam_policy_document" "key" {
  # Política de clave: "Resource: *" significa "esta clave" y AWS lo exige. La administración queda delegada a IAM.
  statement {
    sid       = "EnableIamPolicies"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

resource "aws_kms_key" "state" {
  description             = "Cifrado del bucket de estado de Terraform"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.key.json
}

resource "aws_kms_alias" "state" {
  name          = "alias/fleet-telemetry-tfstate"
  target_key_id = aws_kms_key.state.key_id
}

#trivy:ignore:AWS-0089 Sin bucket de access logs: un segundo bucket de logs tendria el mismo hallazgo. La auditoria de acceso al estado va por CloudTrail (organizacion de Control Tower); ver README.
resource "aws_s3_bucket" "state" {
  bucket = local.bucket_name

  lifecycle {
    # El estado es irrecuperable si se pierde el bucket (el versionado lo protege de borrados de objetos, no del bucket).
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Versionado: cada `apply` conserva el estado anterior (recuperación ante un estado dañado o un borrado).
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
  }
}

# Las versiones viejas del estado no se guardan para siempre.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-noncurrent-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.state]
}
