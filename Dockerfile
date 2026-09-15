# syntax=docker/dockerfile:1

# Replaces the Nixpacks-generated image.
#
# Nixpacks turns every Railway service variable into `ARG X` followed by
# `ENV X=$X`, and `ENV` is written into the final image configuration. That put
# RESEND_API_KEY and DATABASE_URL into image metadata, readable with
# `docker inspect` by anyone who could pull the image, and left there
# permanently even after a key was rotated.
#
# This file declares exactly one ARG, SITE_ENV, which is not a secret and is
# explained where it appears. No application secret is declared anywhere, so
# the build stage cannot see one even if it were passed, and nothing sensitive
# is written into any layer. Railway supplies the secrets to the running
# container at start time, which is all the application ever needed:
# `npm run build` completes with a completely empty environment.
#
# The only ENV values here are non-secret build settings.

FROM node:22-slim AS base
WORKDIR /app
# Keeps the build hermetic: no telemetry call-out during `next build`.
ENV NEXT_TELEMETRY_DISABLED=1


# --------------------------------------------------------------- dependencies
# Full dependency tree, including devDependencies, because `next build` needs
# typescript and the eslint config to be resolvable.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci


# ---------------------------------------------------------- runtime dependencies
# A second, independent install pruned to production. Built in parallel with the
# build stage rather than by pruning afterwards, so the runtime image never
# contains a devDependency layer underneath it.
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ---------------------------------------------------------------------- build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The one build input this application genuinely has, and it is not a secret.
#
# `robots.txt` and the per-page robots meta tag are both prerendered, so the
# preview guard is decided at build time, not at request time. Passing
# SITE_ENV only to the running container leaves the built artefact saying
# `Allow: /` and `index, follow`, which would make the beta preview indexable
# by Google and let it compete with the live site.
#
# Its value is `preview` or nothing, it reveals nothing to anyone who reads it,
# and a preview image is supposed to be identifiable as one. It is set inline
# on the build command rather than with ENV, so it is not written into any
# image configuration, and the runtime stage never receives it at all.
ARG SITE_ENV=""
RUN SITE_ENV="${SITE_ENV}" npm run build


# -------------------------------------------------------------------- runtime
FROM base AS runner
ENV NODE_ENV=production

# Least privilege: the server has no reason to run as root.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder   --chown=nextjs:nodejs /app/.next        ./.next
COPY --from=builder   --chown=nextjs:nodejs /app/public       ./public

# `next start` reads the config at boot, so it ships with the image.
COPY --chown=nextjs:nodejs package.json next.config.ts ./
# Needed by the migration that runs ahead of the server.
COPY --chown=nextjs:nodejs drizzle ./drizzle
COPY --chown=nextjs:nodejs scripts ./scripts

USER nextjs

# Documentation only. Railway injects PORT and `next start` reads it, so the
# container is not bound to this number.
EXPOSE 3000

# Mirrors railway.json's startCommand so the image behaves identically whether
# Railway supplies a start command or falls back to the image default. The
# migration runs first and `&&` means a failure stops the boot rather than
# serving code against a schema that was never applied.
CMD ["sh", "-c", "npm run db:migrate && npm run start"]
