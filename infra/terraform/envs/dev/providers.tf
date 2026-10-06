provider "aws" {
  region = var.aws_region

  # Etiquetas comunes de todo recurso (costos y propiedad).
  default_tags {
    tags = {
      project       = local.project
      env           = local.environment
      owner         = var.owner
      "cost-center" = var.cost_center
      managed-by    = "terraform"
    }
  }
}
