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
}

# TimescaleDB autogestionado en EC2 (decisión aprobada 7): RDS no trae la extensión. Es un contenedor con la MISMA imagen que
# docker-compose.yml (PostgreSQL 17 + TimescaleDB + PostGIS), con los datos en un volumen EBS aparte, cifrado con KMS y con
# snapshots diarios. Sin IP pública, sin llave SSH: se entra con SSM Session Manager.
#
# Alternativa descartada: Timescale Cloud (quita la operación de la base, pero suma un proveedor, su costo y peering de red).
# Un solo nodo, sin réplica: es un ambiente de desarrollo. La alta disponibilidad (réplica + failover) es trabajo futuro.

data "aws_partition" "current" {}
data "aws_region" "current" {}

data "aws_ssm_parameter" "ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_subnet" "this" {
  id = var.subnet_id
}

# --- Credenciales ---------------------------------------------------------------------------------------------------------
# Las contraseñas se generan aquí y quedan SOLO en Secrets Manager (cifrado con KMS) y en el estado remoto (cifrado, con acceso
# restringido). Nunca en archivos del repositorio. Sin caracteres especiales para que sirvan dentro de una URL.
resource "random_password" "postgres" {
  length  = 32
  special = false
}

resource "random_password" "fleet_app" {
  length  = 32
  special = false
}

resource "random_password" "fleet_ro" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "db" {
  name                    = "${var.name}/db"
  description             = "Credenciales y URLs de TimescaleDB (superusuario para migrar, fleet_app para los servicios, fleet_ro de solo lectura)."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    postgres_password  = random_password.postgres.result
    fleet_app_password = random_password.fleet_app.result
    fleet_ro_password  = random_password.fleet_ro.result
    admin_url          = "postgres://fleet:${random_password.postgres.result}@${aws_instance.this.private_dns}:5432/fleet"
    app_url            = "postgres://fleet_app:${random_password.fleet_app.result}@${aws_instance.this.private_dns}:5432/fleet"
    ro_url             = "postgres://fleet_ro:${random_password.fleet_ro.result}@${aws_instance.this.private_dns}:5432/fleet"
  })
}

# --- Logs del contenedor --------------------------------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "db" {
  name              = "/${var.name}/timescaledb"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

# --- IAM de la instancia (mínimo privilegio) -----------------------------------------------------------------------------
data "aws_iam_policy_document" "assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "instance" {
  statement {
    sid       = "ReadOwnDatabaseSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.db.arn]
  }

  statement {
    sid       = "DecryptSecretWithKmsKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "WriteContainerLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.db.arn}:*"]
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name}-timescaledb"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "instance" {
  name   = "database-secret-and-logs"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance.json
}

# SSM Session Manager (acceso sin SSH). Política administrada por AWS: sus permisos con Resource "*" los exige el agente de SSM.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "this" {
  name = "${var.name}-timescaledb"
  role = aws_iam_role.instance.name
}

# --- Volumen de datos -----------------------------------------------------------------------------------------------------
resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.this.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true
  kms_key_id        = var.kms_key_arn

  tags = {
    Name     = "${var.name}-timescaledb-data"
    Snapshot = "${var.name}-timescaledb"
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.this.id
}

# --- Instancia ------------------------------------------------------------------------------------------------------------
resource "aws_instance" "this" {
  ami                         = data.aws_ssm_parameter.ami.value
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = var.security_group_ids
  iam_instance_profile        = aws_iam_instance_profile.this.name
  associate_public_ip_address = false
  ebs_optimized               = true
  monitoring                  = true

  # IMDSv2 obligatorio: mitiga el robo de credenciales por SSRF.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
    kms_key_id  = var.kms_key_arn
  }

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    region             = data.aws_region.current.region
    secret_arn         = aws_secretsmanager_secret.db.arn
    data_volume_serial = replace(aws_ebs_volume.data.id, "-", "")
    log_group          = aws_cloudwatch_log_group.db.name
    image              = var.image
    shared_buffers     = var.shared_buffers
    max_connections    = var.max_connections
  })
  user_data_replace_on_change = false

  tags = { Name = "${var.name}-timescaledb" }

  lifecycle {
    # La AMI "más reciente" cambia a menudo: no se reemplaza una base por eso (se parchea con una ventana de mantenimiento).
    ignore_changes = [ami, user_data]
  }
}

# --- Snapshots diarios del volumen (RPO de 24 h; restauración = volumen nuevo desde snapshot) -------------------------------
data "aws_iam_policy_document" "dlm_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${var.name}-timescaledb-dlm"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume.json
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

# Los snapshots de un volumen cifrado con una CMK necesitan que DLM use la clave.
data "aws_iam_policy_document" "dlm_kms" {
  statement {
    sid       = "UseKeyForSnapshots"
    effect    = "Allow"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = [var.kms_key_arn]
  }

  statement {
    sid       = "GrantsForSnapshots"
    effect    = "Allow"
    actions   = ["kms:CreateGrant"]
    resources = [var.kms_key_arn]

    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }
}

resource "aws_iam_role_policy" "dlm_kms" {
  name   = "use-kms-key"
  role   = aws_iam_role.dlm.id
  policy = data.aws_iam_policy_document.dlm_kms.json
}

resource "aws_dlm_lifecycle_policy" "snapshots" {
  description        = "${var.name}: snapshots diarios de TimescaleDB, ${var.snapshot_retention_days} días"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    target_tags = {
      Snapshot = "${var.name}-timescaledb"
    }

    schedule {
      name = "diario"

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = [var.snapshot_time_utc]
      }

      retain_rule {
        count = var.snapshot_retention_days
      }

      copy_tags = true
    }
  }
}
