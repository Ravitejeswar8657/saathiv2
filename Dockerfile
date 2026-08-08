# Saathi v2 — deploy image.
#
# This exists because Nixpacks gave us a runtime but not a toolchain. better-sqlite3
# is a native addon: it installs a prebuilt binary when one exists for the running
# Node ABI, and falls back to compiling with node-gyp when one does not. Nixpacks
# has no Python, so that fallback failed the build outright the first time Railway
# moved to a Node major without a published prebuild.
#
# Owning the build environment turns that from a failed deploy into a slower build.
# The Node pin in package.json still means the prebuild is normally used; this is
# the safety net for the day it is not.

# ── build ────────────────────────────────────────────────────────────────
# bookworm (glibc), deliberately NOT alpine: better-sqlite3's prebuilt binaries are
# built against glibc, so alpine/musl would force a source build on every image.
FROM node:22-bookworm-slim AS build

# The node-gyp fallback's dependencies. Present only in this stage — the runtime
# image never carries a compiler.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first so the dependency layer is cached across source-only changes.
COPY package.json package-lock.json ./

# `postinstall` runs `node scripts/patch-fontkit.js`, so that file has to exist
# before npm ci or the install exits non-zero on MODULE_NOT_FOUND. It is not
# optional: it guards a null-anchor crash in fontkit's GPOS handling, which is
# what lets the daily-brief PDF render Telugu at all.
COPY scripts/patch-fontkit.js ./scripts/

RUN npm ci --omit=dev

# ── runtime ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# The compiled/downloaded native binary comes from the build stage. Both stages
# share a base image, so the ABI and libc match by construction.
COPY --from=build /app/node_modules ./node_modules

# .dockerignore keeps the local node_modules out, so this cannot clobber the line
# above with a host build of a native module.
COPY . .

# Runs as root deliberately. The app writes saathi.db and three media directories
# into a mounted volume whose ownership the platform decides; dropping to the
# `node` user means an entrypoint that chowns the mount first, and a permission
# failure there is a hard outage rather than a degraded one. Worth revisiting with
# an entrypoint that fixes ownership, but not while it is the only thing standing
# between a deploy and a running app.

# Documentation only — the server binds process.env.PORT, which the platform sets.
EXPOSE 3000

# Local convenience; Railway uses healthcheckPath in railway.toml instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
