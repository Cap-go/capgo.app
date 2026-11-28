FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox-tools

FROM node:24-trixie-slim

COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --from=sandbox-tools /etc/cloudflare/certs/cloudflare-containers-ca.crt /etc/cloudflare/certs/cloudflare-containers-ca.crt

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /workspace/project \
  && chown -R 1000:1000 /workspace

ENV NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt

USER 1000
WORKDIR /workspace/project
CMD ["sleep", "infinity"]