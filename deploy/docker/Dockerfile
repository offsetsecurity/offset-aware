# syntax=docker/dockerfile:1
#
# Offset Aware (formerly the ISO Training Portal) as one Docker image.
#
#   docker build -f deploy/docker/Dockerfile -t offset-aware:1.0.0 .
#
# Everything the portal writes (database, sessions, course packs, its HTTPS
# certificate and logs) goes to /data. Mount a volume there, or it is
# lost when the container is removed. compose.yaml does this.

# ── build ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
# sqlite3 downloads a ready-made driver when one exists for this platform, and
# compiles one when it does not. These are only needed for the second case,
# and stay in this stage.
RUN apk add --no-cache python3 make g++
WORKDIR /src
COPY package.json package-lock.json ./

# node-windows installs the Windows service and has no use here. Take it out,
# then install the rest at the versions in the lockfile, without running any
# install scripts. Then fetch or build the one driver that needs its script.
RUN npm pkg delete dependencies.node-windows \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm rebuild sqlite3

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
ARG APP_VERSION=1.0.0

# dumb-init passes on the stop signal so the portal shuts down cleanly.
#
# The operating system's packages are brought up to date, so a fix published
# since the base image was built is in this one. And npm, npx, corepack and
# yarn are taken out: they are for building, nothing here runs them, and each
# is one more thing in the image that can have a flaw.
RUN apk upgrade --no-cache \
 && apk add --no-cache dumb-init tzdata \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && addgroup -g 10001 -S portal \
 && adduser -u 10001 -S portal -G portal

WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
# Owned by root. The portal user can read and run these files but not change
# them: the running portal cannot rewrite its own code.
COPY package.json server.js quizzes.js logger.js tls.js reset_admin_password.js LICENSE.md ./
COPY public ./public

# INSTALL_KIND=docker makes the portal listen on PORT whatever its settings
# say, and answer the in-app update button with how to update in Docker.
ENV NODE_ENV=production \
    INSTALL_KIND=docker \
    APP_VERSION=${APP_VERSION} \
    PORT=3000 \
    DB_PATH=/data/database.sqlite \
    UPLOADS_DIR=/data/uploads \
    CERT_DIR=/data/certs \
    LOG_DIR=/data/logs \
    TRAINING_DIR=/data/training

# TRAINING_DIR is where course packs added from Settings are kept: in the data
# volume, so an update does not lose them. The five starter videos stay in the
# image and are found there.
#
# /data holds everything the portal writes. /updates is the handoff to the
# updater container, created here so that a fresh named volume mounted over it
# starts owned by the portal user - a volume Docker creates on its own is owned
# by root, and the portal, which runs as nobody in particular, could not write
# the request that asks for an update.
RUN mkdir -p /data /updates/request /updates/status  && chown -R portal:portal /data /updates

USER portal
EXPOSE 3000

# image.source is what ties this package to its repository on GitHub, which
# is also what makes GitHub show that repository's README on the package page.
# Without it a customer arriving at Packages reads nothing at all.
LABEL org.opencontainers.image.title="Offset Aware" \
      org.opencontainers.image.description="Security awareness training for your staff, on your own server." \
      org.opencontainers.image.vendor="Offset Security" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/offsetsecurity/offset-aware"

# The portal always serves HTTPS, with its own certificate, so the check does
# not verify it. It only asks whether the portal is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('https').get({host:'localhost',port:process.env.PORT,path:'/api/setup/status',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]

# ── updater ─────────────────────────────────────────────────────────────────
# The container that installs updates. Built with --target updater.
#
# The portal's own image plus the Docker CLI and compose, because a container
# cannot replace itself: the portal would be swapping the image it is running
# inside. It runs as root because it holds the Docker socket, and it is the
# only container given it. It serves no page and listens on nothing.
FROM runtime AS updater
USER root
COPY --chown=root:root deploy/docker/updater.js ./updater.js
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:29-cli /usr/local/libexec/docker/cli-plugins/docker-compose      /usr/local/libexec/docker/cli-plugins/docker-compose
HEALTHCHECK NONE
CMD ["node", "updater.js"]

# ── default ─────────────────────────────────────────────────────────────────
# The last stage is what a plain `docker build` produces, so it is the portal
# again. Without this, adding the updater above would quietly have turned
# every untargeted build into an updater image.
FROM runtime
# Inherited from runtime already. Said again because a scanner reads the file
# rather than the graph: the last USER above was the updater's root.
USER portal
