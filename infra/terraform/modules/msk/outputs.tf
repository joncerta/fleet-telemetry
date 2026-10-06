output "cluster_arn" {
  description = "ARN del clúster."
  value       = aws_msk_serverless_cluster.this.arn
}

output "cluster_name" {
  description = "Nombre del clúster (dimensión 'Cluster Name' de las métricas AWS/Kafka)."
  value       = aws_msk_serverless_cluster.this.cluster_name
}

output "bootstrap_brokers_sasl_iam" {
  description = "Brokers para clientes con SASL/IAM (host:9098, separados por coma)."
  value       = aws_msk_serverless_cluster.this.bootstrap_brokers_sasl_iam
}

output "topic_arn_prefix" {
  description = "Prefijo de ARN de tópicos: <prefijo>/<tópico>."
  value       = local.topic_arn_prefix
}

output "group_arn_prefix" {
  description = "Prefijo de ARN de consumer groups: <prefijo>/<grupo>."
  value       = local.group_arn_prefix
}
