variable "name" {
  description = "Nombre base (prefijo del ambiente): clúster, ALB, roles y grupos de logs."
  type        = string
}

variable "vpc_id" {
  description = "VPC de los servicios."
  type        = string
}

variable "public_subnet_ids" {
  description = "Subredes públicas (solo el ALB)."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Subredes privadas donde corren las tareas."
  type        = list(string)
}

variable "alb_security_group_id" {
  description = "SG del ALB (443 desde internet; salida solo hacia el SG de las tareas)."
  type        = string
}

variable "tasks_security_group_id" {
  description = "SG de las tareas (entrada solo desde el SG del ALB)."
  type        = string
}

variable "certificate_arn" {
  description = "ARN del certificado ACM del listener 443 (en la misma región). Sin certificado no hay listener HTTPS."
  type        = string
}

variable "kms_key_arn" {
  description = "Clave KMS de los logs y de los secretos."
  type        = string
}

variable "ecr_repository_arns" {
  description = "ARN de los repositorios ECR de los que el rol de ejecución puede bajar imágenes."
  type        = list(string)
}

variable "log_retention_days" {
  description = "Retención de los logs de las tareas en días (valor admitido por CloudWatch Logs)."
  type        = number
  default     = 30
}

variable "cpu_architecture" {
  description = "X86_64 o ARM64. ARM64 cuesta ~20% menos en Fargate, pero exige imágenes multi-arquitectura."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture debe ser X86_64 o ARM64."
  }
}

variable "sse_heartbeat_interval_seconds" {
  description = "Intervalo máximo del heartbeat del SSE que el backend debe garantizar (requisito para fleet-api)."
  type        = number
  default     = 30
}

variable "backend_keep_alive_timeout_seconds" {
  description = "Keep-alive del servidor HTTP de los servicios (Fastify cierra las conexiones ociosas a los 72 s por defecto). El idle timeout del ALB debe ser menor."
  type        = number
  default     = 72
}

variable "alb_idle_timeout_seconds" {
  description = "Idle timeout del ALB. Debe cumplir 2 x heartbeat del SSE <= valor < keep-alive del backend (65 s con 30 s de heartbeat y 72 s de keep-alive); lo exigen dos precondiciones."
  type        = number
  default     = 65

  validation {
    condition     = var.alb_idle_timeout_seconds >= 1 && var.alb_idle_timeout_seconds <= 4000
    error_message = "El idle timeout de un ALB admite de 1 a 4000 segundos."
  }
}

variable "alb_deletion_protection" {
  description = "Protección contra borrado del ALB. Para destruir el ambiente hay que ponerla en false primero."
  type        = bool
  default     = true
}

variable "services" {
  description = <<-EOT
    Servicios de larga duración. Con container_port van detrás del ALB (health_check_path, listener_priority y path_patterns
    son obligatorios en ese caso); sin él solo consumen de Kafka. task_policy_json es la política IAM de la tarea (mínimo
    privilegio); null = sin permisos AWS. secrets: variable de entorno => valueFrom de Secrets Manager (el rol de ejecución de la tarea
    puede leer solo los secretos que aparecen aquí). health_check_command es el healthcheck del CONTENEDOR y health_check_path el del
    target group: ambos deben usar LIVENESS (sin dependencias), nunca readiness; ver README.
  EOT
  type = map(object({
    image                = string
    cpu                  = number
    memory               = number
    desired_count        = number
    environment          = map(string)
    secrets              = map(string)
    task_policy_json     = optional(string)
    command              = optional(list(string))
    container_port       = optional(number)
    health_check_path    = optional(string)
    health_check_command = optional(list(string))
    listener_priority    = optional(number)
    path_patterns        = optional(list(string), [])
  }))

  validation {
    condition = alltrue([
      for service in values(var.services) :
      service.container_port == null || (service.health_check_path != null && service.listener_priority != null && length(service.path_patterns) > 0)
    ])
    error_message = "Un servicio con container_port necesita health_check_path, listener_priority y path_patterns."
  }
}

variable "jobs" {
  description = "Tareas de un solo uso (sin servicio ni ALB), p. ej. las migraciones: se lanzan con `aws ecs run-task` desde el despliegue."
  type = map(object({
    image                = string
    cpu                  = number
    memory               = number
    environment          = map(string)
    secrets              = map(string)
    task_policy_json     = optional(string)
    command              = optional(list(string))
    container_port       = optional(number)
    health_check_command = optional(list(string))
  }))
  default = {}
}
