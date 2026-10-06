output "cluster_name" {
  description = "Nombre del clúster ECS."
  value       = aws_ecs_cluster.this.name
}

output "service_names" {
  description = "Nombres de los servicios ECS."
  value       = [for service in aws_ecs_service.this : service.name]
}

output "alb_dns_name" {
  description = "DNS público del ALB (apuntar el dominio aquí con un CNAME/alias)."
  value       = aws_lb.this.dns_name
}

output "alb_arn_suffix" {
  description = "Sufijo del ARN del ALB (dimensión LoadBalancer de las métricas AWS/ApplicationELB)."
  value       = aws_lb.this.arn_suffix
}

output "target_group_arn_suffixes" {
  description = "Sufijo del ARN de cada target group, por servicio."
  value       = { for name, group in aws_lb_target_group.this : name => group.arn_suffix }
}

output "log_group_names" {
  description = "Grupos de logs por servicio o job."
  value       = { for name, group in aws_cloudwatch_log_group.task : name => group.name }
}

output "job_task_definition_arns" {
  description = "ARN de las definiciones de tarea de los jobs (para `aws ecs run-task`)."
  value       = { for name in keys(var.jobs) : name => aws_ecs_task_definition.this[name].arn }
}
