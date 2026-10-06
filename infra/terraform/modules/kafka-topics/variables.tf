variable "topics" {
  description = "Tópicos a crear: nombre => { partitions, retention_ms }. Sale de modules/topic-catalog."
  type = map(object({
    partitions   = number
    retention_ms = number
  }))

  validation {
    condition     = alltrue([for topic in values(var.topics) : topic.partitions >= 1 && topic.retention_ms > 0])
    error_message = "Cada tópico necesita al menos 1 partición y una retención mayor que 0."
  }
}
