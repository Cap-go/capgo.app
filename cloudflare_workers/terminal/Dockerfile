FROM docker.io/cloudflare/sandbox:1.0.3

RUN mkdir -p /workspace/project \
  && chown -R 1000:1000 /workspace

USER 1000
WORKDIR /workspace/project