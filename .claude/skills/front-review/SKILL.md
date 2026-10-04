---
name: front-review
description: Revisión de FRONTEND (apps/web y apps/mobile) de los cambios pendientes o de la rama actual contra CLAUDE.md, incluida la fidelidad pixel perfect al diseño, antes de hacer commit o abrir un PR. Úsala cuando el humano pida revisar, o antes de proponer un commit que toque web o móvil. Para backend usa arch-review.
argument-hint: "[rama] [enfoque adicional opcional]"
context: fork
agent: frontend-reviewer
allowed-tools: Read, Grep, Glob, Bash(git diff *), Bash(git status *), Bash(git log *), Bash(git show *)
---
Revisa los cambios de frontend del repositorio.

Rama actual: !`git branch --show-current`

Estado (incluye archivos sin trackear):
!`git status --short -- apps/web apps/mobile packages/contracts`

Cambios sin stagear:
!`git diff --stat -- apps/web apps/mobile packages/contracts ':(exclude)**/dist/**' ':(exclude)**/.next/**'`

Cambios en stage:
!`git diff --staged --stat -- apps/web apps/mobile packages/contracts ':(exclude)**/dist/**' ':(exclude)**/.next/**'`

Commits de la rama que no están en develop:
!`git log --oneline develop..HEAD -- apps/web apps/mobile 2>/dev/null`

Argumentos del humano: $ARGUMENTS

## Alcance

- Si los argumentos empiezan con `rama`, revisa **toda la rama contra develop** (`git diff develop...HEAD` más lo pendiente). Si no, revisa **solo los cambios pendientes** (sin stagear, en stage y archivos sin trackear).
- El resto de los argumentos es un enfoque adicional que el humano pide priorizar (por ejemplo, "pixel perfect del panel de alertas"). Puede estar vacío.
- Ignora `.next/`, `dist/`, código generado y lockfiles. **Sí revisa los snapshots visuales**: uno regenerado sin explicación es un hallazgo.
- Si hay cambios en contratos, auth, payloads o en el consumo de SSE, indica al final: "Toca integración con el back: correr /arch-review".
- Si el diff es muy grande, prioriza por severidad. Dilo explícitamente si no alcanzaste a revisar todo, y lista qué archivos quedaron fuera.

## Entrega

Aplica tu proceso completo y entrega los hallazgos y el veredicto con tu formato.

Al final, agrega:
- Si el veredicto es `RECHAZADO`: "No proponer commit hasta corregir los hallazgos críticos".
- Por cada hallazgo marcado como candidato a auditoría IA, una línea lista para usar:
  `/ai-audit-entry <título corto del hallazgo>`
