# syntax=docker/dockerfile:1
#
# Imagen de un servicio del monorepo (`--build-arg SERVICE=ingest-gateway|processor`) y del job de migraciones
# (`--target migrate`, con SERVICE=platform). Se construye SIEMPRE desde la raíz del repositorio:
#
#   docker build -f infra/docker/service.Dockerfile --build-arg SERVICE=processor -t fleet/processor:local .
#
# Empaquetado con `pnpm deploy --prod`: copia el servicio y sus dependencias de workspace (@fleet/contracts,
# @fleet/platform, ya compiladas) a una carpeta autocontenida con solo las dependencias de producción. Se eligió sobre
# `turbo prune` porque deja la imagen final sin el resto del monorepo y sin devDependencies; `turbo prune` solo reduce el
# contexto de instalación y igual habría que instalar y podar después.
#
# Sin secretos: la imagen no lleva .env ni credenciales (ver .dockerignore); todo llega por variables de entorno.

ARG NODE_IMAGE=node:24.18.0-bookworm-slim

# --- base: Node + pnpm (la versión sale de `packageManager` de package.json, vía corepack) ---
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable
WORKDIR /repo

# --- build: instala el workspace completo, compila el paquete y sus dependencias, y lo empaqueta en /out ---
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
# El ARG va DESPUÉS de la instalación: todo RUN posterior a un ARG lo recibe como variable de entorno y su valor entra en la
# clave de caché. Antes del install, cada imagen repetía la instalación completa del workspace en una capa propia (una copia
# de node_modules por imagen), y en CI el runner se quedaba sin disco. Así la capa del install es una sola y la comparten todas las imágenes.
ARG SERVICE=platform
# `...` incluye las dependencias de workspace del paquete (contracts, platform).
RUN pnpm --filter "@fleet/${SERVICE}..." run build
# `deploy` copia todo el paquete; en runtime solo hacen falta dist/ y node_modules/ (sin fuentes, tests ni configs).
RUN pnpm --filter "@fleet/${SERVICE}" deploy --prod /out \
    && rm -rf /out/src /out/tests /out/global-setup.ts /out/vitest*.ts /out/tsconfig*.json /out/pnpm-lock.yaml /out/pnpm-workspace.yaml

# --- migrate: job de un solo uso (`node packages/platform/dist/cli/migrate.js`) ---
# /out es @fleet/platform compilado con sus dependencias de producción. defaultMigrationsDir resuelve
# `../../../../infra/db/migrations` desde packages/platform/dist/migrations, por eso se conserva esa disposición bajo /app.
FROM ${NODE_IMAGE} AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./packages/platform
COPY --from=build --chown=node:node /repo/infra/db/migrations ./infra/db/migrations
# Usuario no root integrado en la imagen oficial de Node (uid 1000).
USER node
CMD ["node", "packages/platform/dist/cli/migrate.js"]

# --- service: imagen final del servicio (último stage = target por defecto) ---
FROM ${NODE_IMAGE} AS service
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "dist/main.js"]
