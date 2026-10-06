output "key_arn" {
  description = "ARN de la clave KMS del ambiente."
  value       = aws_kms_key.this.arn
}

output "key_id" {
  description = "ID de la clave KMS del ambiente."
  value       = aws_kms_key.this.key_id
}
