FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox-tools

FROM node:24-trixie-slim

COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

RUN mkdir -p /workspace/project \
  && chown -R 1000:1000 /workspace

USER 1000
WORKDIR /workspace/project
CMD ["sleep", "infinity"]