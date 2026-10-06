output "instance_id" {
  description = "ID de la instancia EC2 (acceso con SSM Session Manager)."
  value       = aws_instance.this.id
}

output "private_dns" {
  description = "DNS privado de la base (puerto 5432)."
  value       = aws_instance.this.private_dns
}

output "secret_arns" {
  description = "ARN de los secretos por rol: admin (postgres_password, fleet_app_password, fleet_ro_password, admin_url), app (app_url) y ro (ro_url)."
  value       = { for name, secret in aws_secretsmanager_secret.db : name => secret.arn }
}
