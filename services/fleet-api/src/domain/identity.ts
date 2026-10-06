/**
 * Identidad verificada de quien hace la petición. Sale SOLO de la sesión firmada (regla 4): nunca del body, la query ni un
 * argumento del LLM. Toda consulta del read model filtra por su `tenantId`.
 */
export interface AuthIdentity {
  readonly userId: string;
  readonly tenantId: string;
}
