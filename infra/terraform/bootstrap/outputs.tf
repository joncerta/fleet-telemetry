output "state_bucket" {
  description = "Bucket de estado: va en `bucket` de backend.hcl."
  value       = aws_s3_bucket.state.id
}

output "state_kms_key_arn" {
  description = "Clave KMS del bucket: va en `kms_key_id` de backend.hcl."
  value       = aws_kms_key.state.arn
}
