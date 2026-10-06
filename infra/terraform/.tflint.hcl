# tflint de las raíces y módulos de Terraform. Se ejecuta desde infra/terraform:
#   tflint --recursive --config "$(pwd)/.tflint.hcl"
# Ruleset `terraform` (incluido en tflint): versiones fijadas, variables y salidas documentadas y con tipo, sin declaraciones sin usar.
# El ruleset de AWS exige descargar un plugin (`tflint --init`); se agrega cuando el CI lo permita.

config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

rule "terraform_required_version" {
  enabled = true
}

rule "terraform_required_providers" {
  enabled = true
}

rule "terraform_documented_variables" {
  enabled = true
}

rule "terraform_documented_outputs" {
  enabled = true
}

rule "terraform_typed_variables" {
  enabled = true
}

rule "terraform_unused_declarations" {
  enabled = true
}

rule "terraform_naming_convention" {
  enabled = true
}
