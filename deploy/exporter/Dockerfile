FROM node:22-slim

# Install system dependencies: git and ca-certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git \
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
