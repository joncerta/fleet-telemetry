/**
 * Identidad VERIFICADA del usuario que pregunta, tomada de la cookie de sesión firmada. Es lo único que decide de qué tenant se
 * leen los datos: nunca sale del cuerpo de la petición ni de un argumento que rellene el LLM (reglas 4 y 10 de CLAUDE.md).
 */
export interface AgentIdentity {
  readonly userId: string;
  readonly tenantId: string;
}
