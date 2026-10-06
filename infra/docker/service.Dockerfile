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
# La web (`--target web`, Next.js standalone) comparte este archivo: la capa de instalación del workspace (stage `deps`) es la
# misma para todas las imágenes, así que añadir la web no repite `pnpm install` ni duplica node_modules en disco.
#
#   docker build -f infra/docker/service.Dockerfile --target web -t fleet-telemetry/web:local .
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

# --- deps: instala el workspace completo UNA vez; de aquí salen todas las imágenes (servicios, migrate y web) ---
FROM base AS deps
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- build: compila el paquete y sus dependencias, y lo empaqueta en /out ---
FROM deps AS build
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

# --- web-build: compila la web (Next.js, salida `standalone`) ---
# Las `NEXT_PUBLIC_*` se INCRUSTAN en el bundle del navegador al compilar: no se pueden cambiar al arrancar el contenedor. Los
# valores por defecto sirven para el compose local (el navegador del humano llega a los puertos publicados en 127.0.0.1); para
# otro origen hay que reconstruir con `--build-arg`. Son URLs públicas, no secretos. Van DESPUÉS del install (ver arriba).
FROM deps AS web-build
ARG NEXT_PUBLIC_FLEET_API_URL=http://localhost:4002
ARG NEXT_PUBLIC_AGENT_URL=http://localhost:4003
ARG NEXT_PUBLIC_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/positron
ENV NEXT_PUBLIC_FLEET_API_URL=${NEXT_PUBLIC_FLEET_API_URL} \
    NEXT_PUBLIC_AGENT_URL=${NEXT_PUBLIC_AGENT_URL} \
    NEXT_PUBLIC_MAP_STYLE_URL=${NEXT_PUBLIC_MAP_STYLE_URL} \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
# `...` compila también las dependencias de workspace: `next build` verifica los tipos de todo el proyecto, e2e/ incluido, que importa
# @fleet/dev-data y @fleet/platform (sin compilar falla el typecheck). Luego `build` de la web copia el worker de MapLibre a
# public/vendor/maplibre y corre `next build`. Nada de eso llega a la imagen final: solo el standalone.
RUN pnpm --filter "@fleet/web..." run build

# --- web: imagen final (Next.js standalone: server.js + solo los node_modules trazados) ---
# Con `outputFileTracingRoot` en la raíz del monorepo, standalone conserva la ruta: server.js queda en apps/web/.
# `.next/static` y `public` no entran en standalone y se copian aparte.
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=web-build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# --- service: imagen final del servicio. Va ÚLTIMO a propósito: es el target por defecto de `docker build` sin `--target` ---
FROM ${NODE_IMAGE} AS service
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "dist/main.js"]
