# Exact multi-architecture Deno base image for the published provider runtime.
FROM denoland/deno:debian-2.9.6@sha256:2014dc167ece617ef7e7ba40631ac2234c59e75ce693e7cc2dc2602b3c87859d

ARG VERSION=0.6.1
ARG VCS_REF=unknown
ARG CREATED=unknown

LABEL org.opencontainers.image.title="mcp-build123d" \
      org.opencontainers.image.description="Qualified Build123d MCP provider" \
      org.opencontainers.image.source="https://github.com/Casys-AI/mcp-build123d" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.created="$CREATED"

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgl1 python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/build123d

WORKDIR /app
COPY requirements/ requirements/
RUN /opt/build123d/bin/python -m pip install --no-cache-dir --upgrade pip \
    && /opt/build123d/bin/python -m pip install --no-cache-dir \
        -r requirements/runtime.txt -c requirements/constraints.txt \
    && /opt/build123d/bin/python -c "import build123d, OCP; assert build123d.__version__ == '0.11.1'; assert OCP.__version__ == '7.9.3.1'"

COPY . .
ENV DENO_DIR=/home/deno/.cache/deno
ENV HOME=/home/deno
RUN deno cache --frozen server.ts \
    && mkdir -p /exports /home/deno/.cache/ezdxf \
    && chown -R deno:deno /app /exports /home/deno

ENV BUILD123D_PYTHON_BIN=/opt/build123d/bin/python
ENV BUILD123D_EXPORT_DIR=/exports
USER deno
EXPOSE 3014
CMD ["deno", "run", "-A", "server.ts", "--hostname=0.0.0.0", "--port=3014"]
