output "instance_id" {
  description = "ID de la instancia EC2 (acceso con SSM Session Manager)."
  value       = aws_instance.this.id
}

output "private_dns" {
  description = "DNS privado de la base (puerto 5432)."
  value       = aws_instance.this.private_dns
}

output "secret_arn" {
  description = "ARN del secreto con las credenciales y URLs (claves: postgres_password, fleet_app_password, fleet_ro_password, admin_url, app_url, ro_url)."
  value       = aws_secretsmanager_secret.db.arn
}
