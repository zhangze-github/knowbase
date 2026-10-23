FROM node:22-slim

# Install system dependencies: git, ssh client (slim 镜像不带 ssh，SSH 远端 clone/push 必需) and ca-certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      util-linux \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install an explicit release; override only when intentionally deploying another version.
ARG KNOWBASE_VERSION=1.1.2
RUN npm i -g "knowbase@${KNOWBASE_VERSION}"

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
COPY healthcheck.cjs /healthcheck.cjs
RUN chmod +x /entrypoint.sh

# Ensure /data directory exists for volume mount
RUN mkdir -p /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD ["node", "/healthcheck.cjs"]

# Use entrypoint script
ENTRYPOINT ["/entrypoint.sh"]
