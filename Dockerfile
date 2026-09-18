# syntax=docker/dockerfile:1

# quanticode shells out to `git blame`, so unlike most Go services this image
# cannot be FROM scratch: git has to be present at runtime.

# --- frontend -----------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-alpine AS web

WORKDIR /src/web
# Dependencies first, so a source-only change does not reinstall them.
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- server -------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.22-alpine AS server

WORKDIR /src
COPY go.mod ./
COPY cmd/ cmd/
COPY internal/ internal/

# TARGETOS/TARGETARCH come from buildx; cross-compiling from the build
# platform is far quicker than emulating the target to run a native compiler.
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" \
    -o /out/quanticode ./cmd/quanticode

# --- runtime ------------------------------------------------------------
FROM alpine:3.20

RUN apk add --no-cache git ca-certificates tini \
    && adduser -D -u 65532 -h /home/quanticode quanticode

# A repository is mounted in from the host and will be owned by some other uid,
# which git refuses to read ("dubious ownership"). Setting this through the
# environment rather than a config file means the container needs no writable
# HOME and works under any --user.
ENV GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=*

COPY --from=server /out/quanticode /usr/local/bin/quanticode
COPY --from=web /src/web/dist/ /srv/web/dist/

# The default -web value is "web/dist", which resolves here.
WORKDIR /srv
USER quanticode
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8090/healthz || exit 1

# tini reaps the git processes quanticode spawns per file.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/quanticode"]
CMD ["-addr", ":8090"]

LABEL org.opencontainers.image.title="quanticode" \
      org.opencontainers.image.description="Quanticode: measurable perspectives on a codebase. The heat lens colours every file and every line by how recently it last changed." \
      org.opencontainers.image.source="https://github.com/clems4ever/quanticode" \
      org.opencontainers.image.licenses="Apache-2.0"
