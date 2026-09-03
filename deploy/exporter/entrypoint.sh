#!/bin/bash

set -e

REPO_DIR="/data/repo"
SPACE="${KNOWBASE_LARK_SPACE:-}"

# Validate required environment variables
if [ -z "$KNOWBASE_LARK_SPACE" ]; then
  echo "Error: KNOWBASE_LARK_SPACE environment variable is required" >&2
  exit 1
fi

# Clone repository if .git directory does not exist
if [ ! -d "$REPO_DIR/.git" ]; then
  if [ -z "$KNOWBASE_MIRROR_REPO_URL" ]; then
    echo "Error: KNOWBASE_MIRROR_REPO_URL environment variable is required for initial clone" >&2
    exit 1
  fi

  echo "Cloning repository from $KNOWBASE_MIRROR_REPO_URL..."
  git clone "$KNOWBASE_MIRROR_REPO_URL" "$REPO_DIR"
fi

# Configure git identity
git -C "$REPO_DIR" config user.name "knowbase-exporter"
git -C "$REPO_DIR" config user.email "exporter@knowbase.local"

# Execute knowbase exporter command
# Note: secrets KNOWBASE_LARK_APP_ID and KNOWBASE_LARK_APP_SECRET are passed via environment variables
# KNOWBASE_EXPORTER_EXTRA_ARGS is intentionally unquoted to allow word-splitting of multiple arguments
exec knowbase exporter --repo "$REPO_DIR" --space "$SPACE" ${KNOWBASE_EXPORTER_EXTRA_ARGS}
