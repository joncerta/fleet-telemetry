output "vpc_id" {
  description = "ID de la VPC."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "CIDR de la VPC."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Subredes públicas (solo ALB y NAT)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Subredes privadas (servicios y datos)."
  value       = aws_subnet.private[*].id
}

output "private_subnet_cidrs" {
  description = "CIDR de las subredes privadas."
  value       = aws_subnet.private[*].cidr_block
}
