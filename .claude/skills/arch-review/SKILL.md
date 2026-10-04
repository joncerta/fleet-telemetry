---
name: arch-review
description: Revisión arquitectónica de BACKEND (services/, packages/, infra/) de los cambios pendientes o de la rama actual contra CLAUDE.md, antes de hacer commit o abrir un PR. Úsala cuando el humano pida revisar, o antes de proponer un commit que toque backend. Para apps/web y apps/mobile usa front-review.
argument-hint: "[rama] [enfoque adicional opcional]"
context: fork
agent: architect-reviewer
allowed-tools: Read, Grep, Glob, Bash(git diff *), Bash(git status *), Bash(git log *), Bash(git show *)
---
Revisa los cambios de backend del repositorio.

Rama actual: !`git branch --show-current`

Estado (incluye archivos sin trackear):
!`git status --short`

Cambios sin stagear:
!`git diff --stat -- . ':(exclude)pnpm-lock.yaml' ':(exclude)**/dist/**'`

Cambios en stage:
!`git diff --staged --stat -- . ':(exclude)pnpm-lock.yaml' ':(exclude)**/dist/**'`

Commits de la rama que no están en main:
!`git log --oneline main..HEAD 2>/dev/null`

Argumentos del humano: $ARGUMENTS

## Alcance

- Si los argumentos empiezan con `rama`, revisa **toda la rama contra main** (`git diff main...HEAD` más lo pendiente). Si no, revisa **solo los cambios pendientes** (sin stagear, en stage y archivos sin trackear).
- El resto de los argumentos es un enfoque adicional que el humano pide priorizar. Puede estar vacío.
- Ignora `pnpm-lock.yaml`, `dist/`, código generado y snapshots, salvo que el cambio en ellos sea sospechoso (por ejemplo, un snapshot regenerado sin cambio de código que lo justifique).
- Si hay cambios en `apps/web` o `apps/mobile`, revisa solo su integración con el back (contratos, auth, payloads, SSE) e indica al final: "Hay cambios de front: correr /front-review".
- Si el diff es muy grande, prioriza por severidad. Dilo explícitamente si no alcanzaste a revisar todo, y lista qué archivos quedaron fuera.

## Entrega

Aplica tu proceso completo y entrega los hallazgos y el veredicto con tu formato.

Al final, agrega:
- Si el veredicto es `RECHAZADO`: "No proponer commit hasta corregir los hallazgos críticos".
- Por cada hallazgo marcado como candidato a auditoría IA, una línea lista para usar:
  `/ai-audit-entry <título corto del hallazgo>`
