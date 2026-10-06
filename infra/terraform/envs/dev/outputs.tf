output "alb_dns_name" {
  description = "DNS público del ALB: apuntar el dominio del certificado aquí (alias/CNAME)."
  value       = module.services.alb_dns_name
}

output "ecr_repository_urls" {
  description = "Repositorios ECR por imagen."
  value       = module.ecr.repository_urls
}

output "ecs_cluster_name" {
  description = "Clúster ECS."
  value       = module.services.cluster_name
}

output "migrate_task_definition_arn" {
  description = "Tarea de migraciones, para `aws ecs run-task` desde el despliegue."
  value       = module.services.job_task_definition_arns["migrate"]
}

output "database_instance_id" {
  description = "Instancia EC2 de TimescaleDB (acceso con SSM Session Manager)."
  value       = module.timescaledb.instance_id
}

output "database_secret_arns" {
  description = "Secretos de la base por rol: admin (solo migrate), app (servicios) y ro (solo lectura)."
  value       = module.timescaledb.secret_arns
}

output "msk_cluster_name" {
  description = "Clúster MSK Serverless."
  value       = module.msk.cluster_name
}

output "bootstrap_brokers_parameter_name" {
  description = "Nombre del parámetro de SSM con los brokers SASL/IAM: es el valor de brokers_parameter_name de envs/dev-topics (sin remote state)."
  value       = aws_ssm_parameter.bootstrap_brokers.name
}

output "topics_admin_security_group_id" {
  description = "SG que debe llevar el runner (o el túnel SSM) que aplica envs/dev-topics: es el único origen admitido por MSK además de las tareas."
  value       = aws_security_group.topics_admin.id
}

output "topics_admin_policy_arn" {
  description = "Política IAM del principal que aplica envs/dev-topics (crear y describir los tópicos del catálogo, leer el parámetro de brokers)."
  value       = aws_iam_policy.topics_admin.arn
}

output "alarms_topic_arn" {
  description = "Tema SNS de alarmas."
  value       = module.observability.sns_topic_arn
}
