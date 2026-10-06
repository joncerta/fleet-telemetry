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

output "database_secret_arn" {
  description = "Secreto con las credenciales de la base."
  value       = module.timescaledb.secret_arn
}

output "msk_cluster_name" {
  description = "Clúster MSK Serverless."
  value       = module.msk.cluster_name
}

output "bootstrap_brokers_sasl_iam" {
  description = "Brokers SASL/IAM; los lee la raíz envs/dev-topics para crear los tópicos."
  value       = module.msk.bootstrap_brokers_sasl_iam
}

output "alarms_topic_arn" {
  description = "Tema SNS de alarmas."
  value       = module.observability.sns_topic_arn
}
