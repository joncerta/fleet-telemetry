variable "name" {
  description = "Nombre base (prefijo del ambiente)."
  type        = string
}

variable "subnet_id" {
  description = "Subred PRIVADA donde corre la instancia."
  type        = string
}

variable "security_group_ids" {
  description = "Grupos de seguridad de la instancia (el origen permitido en 5432 se define en la raíz, por SG de origen)."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "Clave KMS de los volúmenes EBS, los snapshots, el secreto y los logs."
  type        = string
}

variable "instance_type" {
  description = "Tipo de instancia. t3.medium (2 vCPU, 4 GiB) alcanza para desarrollo; no sobredimensionar."
  type        = string
  default     = "t3.medium"
}

variable "image" {
  description = "Imagen de TimescaleDB. Debe ser la MISMA que usa docker-compose.yml (versión fija, nunca latest)."
  type        = string
  default     = "timescale/timescaledb-ha:pg17.11-ts2.30.2"

  validation {
    condition     = !endswith(var.image, ":latest") && can(regex(":", var.image))
    error_message = "La imagen debe llevar un tag fijo, nunca latest."
  }
}

variable "root_volume_gb" {
  description = "Tamaño del volumen raíz (sistema operativo y Docker)."
  type        = number
  default     = 20
}

variable "data_volume_gb" {
  description = "Tamaño del volumen de datos de la base. gp3 permite ampliarlo sin parar la instancia."
  type        = number
  default     = 50
}

variable "shared_buffers" {
  description = "shared_buffers de PostgreSQL (aprox. 25% de la RAM de la instancia)."
  type        = string
  default     = "1GB"
}

variable "max_connections" {
  description = "max_connections de PostgreSQL. Cada servicio abre un pool pequeño (10 por defecto)."
  type        = number
  default     = 100
}

variable "snapshot_retention_days" {
  description = "Snapshots diarios que se conservan (retención de los backups)."
  type        = number
  default     = 7
}

variable "snapshot_time_utc" {
  description = "Hora UTC (HH:MM) del snapshot diario, en una ventana de poca carga."
  type        = string
  default     = "08:00"
}

variable "log_retention_days" {
  description = "Retención de los logs del contenedor en días (valor admitido por CloudWatch Logs)."
  type        = number
  default     = 30
}

variable "secret_recovery_window_days" {
  description = "Días de recuperación del secreto tras borrarlo (7 a 30)."
  type        = number
  default     = 7
}

variable "credentials_version" {
  description = "Versión de las credenciales (entero >= 1). Subirla reescribe las contraseñas en los tres secretos (rotación); ver el README, sección Rotación."
  type        = number
  default     = 1

  validation {
    condition     = var.credentials_version >= 1 && var.credentials_version == floor(var.credentials_version) && var.credentials_version < 100
    error_message = "credentials_version debe ser un entero entre 1 y 99."
  }
}
