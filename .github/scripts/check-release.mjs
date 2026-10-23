import fs from "node:fs";
import { pathToFileURL } from "node:url";

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function releaseDecision(pkg, lock, metadata) {
  if (pkg.name !== "knowbase") throw new Error("Unexpected package name");
  if (!stable.test(pkg.version)) throw new Error("Only stable x.y.z versions can publish to latest");
  if (lock.name !== pkg.name || lock.version !== pkg.version ||
      lock.packages?.[""]?.name !== pkg.name || lock.packages?.[""]?.version !== pkg.version) {
    throw new Error("package.json and lockfile must have the same name and version");
  }
  const latest = metadata?.["dist-tags"]?.latest;
  if (metadata?.name !== pkg.name || !stable.test(latest) ||
      !metadata.versions || typeof metadata.versions !== "object" || Array.isArray(metadata.versions)) {
    throw new Error("Unexpected registry metadata");
  }
  if (Object.hasOwn(metadata.versions, pkg.version)) {
    return { publish: false, version: pkg.version, reason: "Version already published" };
  }
  const next = pkg.version.split(".").map(BigInt);
  const previous = latest.split(".").map(BigInt);
  const different = next.findIndex((part, index) => part !== previous[index]);
  if (different === -1 || next[different] < previous[different]) {
    throw new Error(`Version ${pkg.version} must be newer than npm latest ${latest}`);
  }
  return { publish: true, version: pkg.version, reason: `New version after ${latest}` };
}

export async function readRegistry(fetcher = fetch) {
  const response = await fetcher("https://registry.npmjs.org/knowbase", {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  const result = releaseDecision(pkg, lock, await readRegistry());
  console.log(`${pkg.name}@${result.version}: ${result.reason}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `should_publish=${result.publish}\n`);
  }
}
