#!/bin/bash

set -e

REPO_DIR="/data/repo"
SPACE="${KNOWBASE_LARK_SPACE:-}"
CLONE_TIMEOUT="${KNOWBASE_EXPORTER_CLONE_TIMEOUT_SECONDS:-120}"

# Validate required environment variables
if [ -z "$SPACE" ]; then
  echo "Error: KNOWBASE_LARK_SPACE environment variable is required" >&2
  exit 1
fi

# Lock the directory inode: a lockfile inside it would prevent the first clone.
# fd 9 survives exec, keeping the lock for the entire exporter process lifetime.
mkdir -p "$REPO_DIR"
exec 9<"$REPO_DIR"
if ! flock -n 9; then
  echo "Error: another exporter holds the repository directory lock" >&2
  exit 1
fi

# Clone repository if .git directory does not exist
if [ ! -d "$REPO_DIR/.git" ]; then
  if [ -z "$KNOWBASE_MIRROR_REPO_URL" ]; then
    echo "Error: KNOWBASE_MIRROR_REPO_URL environment variable is required for initial clone" >&2
    exit 1
  fi

  if ! [[ "$CLONE_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: KNOWBASE_EXPORTER_CLONE_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 1
  fi
  export GIT_TERMINAL_PROMPT=0
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=2}"
  echo "Cloning mirror repository..."
  timeout --signal=TERM --kill-after=10s "${CLONE_TIMEOUT}s" git clone "$KNOWBASE_MIRROR_REPO_URL" "$REPO_DIR"
fi

# Configure git identity
git -C "$REPO_DIR" config user.name "knowbase-exporter"
git -C "$REPO_DIR" config user.email "exporter@knowbase.local"

# Execute knowbase exporter command
# Note: secrets KNOWBASE_LARK_APP_ID and KNOWBASE_LARK_APP_SECRET are passed via environment variables
# KNOWBASE_EXPORTER_EXTRA_ARGS is intentionally unquoted to allow word-splitting of multiple arguments
exec knowbase exporter --repo "$REPO_DIR" --space "$SPACE" ${KNOWBASE_EXPORTER_EXTRA_ARGS}
