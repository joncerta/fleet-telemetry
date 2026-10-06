output "topic_names" {
  description = "Nombres de los tópicos creados."
  value       = [for topic in kafka_topic.this : topic.name]
}
