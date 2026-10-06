output "repository_urls" {
  description = "URL de cada repositorio, por nombre de imagen."
  value       = { for name, repository in aws_ecr_repository.this : name => repository.repository_url }
}

output "repository_arns" {
  description = "ARN de cada repositorio, por nombre de imagen."
  value       = { for name, repository in aws_ecr_repository.this : name => repository.arn }
}
