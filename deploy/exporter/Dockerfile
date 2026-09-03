FROM node:22-slim

# Install system dependencies: git, ssh client (slim 镜像不带 ssh，SSH 远端 clone/push 必需) and ca-certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install knowbase globally
RUN npm i -g knowbase

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Ensure /data directory exists for volume mount
RUN mkdir -p /data

# Use entrypoint script
ENTRYPOINT ["/entrypoint.sh"]
