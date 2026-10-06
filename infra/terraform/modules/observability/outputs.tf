output "sns_topic_arn" {
  description = "Tema SNS de alarmas."
  value       = aws_sns_topic.alarms.arn
}
