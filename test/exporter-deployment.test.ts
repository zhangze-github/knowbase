import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function probe(state: unknown, options: { homeFallback?: boolean; override?: boolean; maxAge?: string; raw?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "knowbase-health-"));
  directories.push(directory);
  const config = options.homeFallback ? join(directory, ".config") : join(directory, "xdg");
  const file = options.override ? join(directory, "custom-health.json") : join(config, "knowbase", "exporter-health.json");
  mkdirSync(join(config, "knowbase"), { recursive: true });
  if (state !== undefined || options.raw !== undefined) writeFileSync(file, options.raw ?? JSON.stringify(state));
  return spawnSync(process.execPath, [resolve("deploy/exporter/healthcheck.cjs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: directory,
      XDG_CONFIG_HOME: options.homeFallback ? "" : config,
      KNOWBASE_EXPORTER_HEALTH_FILE: options.override ? file : "",
      KNOWBASE_EXPORTER_HEALTH_MAX_AGE_SECONDS: options.maxAge ?? "",
    },
  });
}

function healthy() {
  return {
    started_at: new Date(Date.now() - 120_000).toISOString(),
    last_cycle_at: new Date(Date.now() - 30_000).toISOString(),
    last_success_at: new Date(Date.now() - 30_000).toISOString(),
  };
}

describe("exporter deployment health probe", () => {
  it.each([{}, { homeFallback: true }, { override: true }])("accepts a recent successful push at the configured path: %j", (options) => {
    expect(probe(healthy(), options).status).toBe(0);
  });

  it("rejects startup before any successful push", () => {
    expect(probe({ started_at: new Date().toISOString() }).status).toBe(1);
  });

  it("rejects a recent failure even when the previous push is fresh without exposing its details", () => {
    const result = probe({ ...healthy(), last_error: "private-token-value" });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("private-token-value");
  });

  it("rejects a stale success even if a cycle ran recently", () => {
    expect(probe({ ...healthy(), last_success_at: new Date(Date.now() - 601_000).toISOString() }).status).toBe(1);
  });

  it("honors a configured success age", () => {
    expect(probe(healthy(), { maxAge: "10" }).status).toBe(1);
    expect(probe({ ...healthy(), last_success_at: new Date(Date.now() - 601_000).toISOString() }, { maxAge: "900" }).status).toBe(0);
  });

  it.each([undefined, null, [], {}, { ...healthy(), started_at: "invalid" }, { ...healthy(), last_cycle_at: 123 }, { ...healthy(), last_error: {} }, { ...healthy(), last_success_at: new Date(Date.now() + 60_000).toISOString() }])("rejects missing or malformed state: %j", (state) => {
    expect(probe(state).status).toBe(1);
  });

  it("rejects invalid JSON", () => {
    expect(probe(undefined, { raw: "{" }).status).toBe(1);
  });

  it.each(["0", "-1", "NaN", "Infinity", "bad"])("rejects invalid maximum age %s", (maxAge) => {
    expect(probe(healthy(), { maxAge }).status).toBe(1);
  });
});

// Opt-in: use a disposable image with bash, git, flock, timeout and Node. No host data,
// network access, credentials, persistent volumes or live exporter are involved.
describe.skipIf(process.env.KNOWBASE_TEST_DOCKER !== "1")("exporter deployment entrypoint", () => {
  it("holds one directory lock across initial clone and the running exporter", () => {
    const result = spawnSync("docker", [
      "run", "--rm", "--network", "none", "--entrypoint", "/bin/bash",
      "-v", `${resolve("deploy/exporter")}:/fixture:ro`,
      process.env.KNOWBASE_TEST_DOCKER_IMAGE ?? "knowbase-exporter:test",
      "-c", `
set -euo pipefail
mkdir -p /fixture-bin /data
git init --bare /tmp/remote.git >/dev/null 2>&1
cat >/fixture-bin/knowbase <<'SH'
#!/bin/bash
touch /tmp/daemon-started
exec node -e 'setInterval(() => {}, 1000)'
SH
cat >/fixture-bin/git <<'SH'
#!/bin/bash
if [ "$1" = clone ]; then
  touch /tmp/clone-started
  while [ ! -f /tmp/allow-clone ]; do sleep 0.05; done
fi
exec /usr/bin/git "$@"
SH
chmod +x /fixture-bin/*
export PATH="/fixture-bin:$PATH" KNOWBASE_LARK_SPACE=fixture KNOWBASE_MIRROR_REPO_URL=/tmp/remote.git
bash /fixture/entrypoint.sh >/tmp/first.log 2>&1 &
first=$!
trap 'kill "$first" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do [ ! -f /tmp/clone-started ] || break; sleep 0.05; done
test -f /tmp/clone-started
if bash /fixture/entrypoint.sh >/tmp/second.log 2>&1; then exit 21; fi
test ! -d /data/repo/.git
touch /tmp/allow-clone
for i in $(seq 1 100); do [ ! -f /tmp/daemon-started ] || break; sleep 0.05; done
test -f /tmp/daemon-started
test -d /data/repo/.git
if bash /fixture/entrypoint.sh >/tmp/third.log 2>&1; then exit 22; fi
kill "$first"
wait "$first" || true
trap - EXIT
flock -n /data/repo true
`,
    ], { encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
