import { describe, expect, it } from "vitest";
import { releaseDecision, readRegistry } from "../.github/scripts/check-release.mjs";

const pkg = { name: "knowbase", version: "1.1.1" };
const lock = (version = pkg.version) => ({
  name: "knowbase", version, packages: { "": { name: "knowbase", version } },
});
const registry = {
  name: "knowbase", "dist-tags": { latest: "1.1.0" }, versions: { "1.1.0": {} },
};

describe("npm release decision", () => {
  it("publishes an unpublished version newer than latest", () => {
    expect(releaseDecision(pkg, lock(), registry).publish).toBe(true);
  });
  it("skips an already published version", () => {
    expect(releaseDecision({ ...pkg, version: "1.1.0" }, lock("1.1.0"), registry).publish).toBe(false);
  });
  it("rejects an unpublished version older than latest", () => {
    expect(() => releaseDecision({ ...pkg, version: "1.0.2" }, lock("1.0.2"), registry)).toThrow(/latest/);
  });
  it.each(["1.2.0-beta.1", "01.2.0", "1.2", "v1.2.0"])("rejects nonstable version %s", version => {
    expect(() => releaseDecision({ ...pkg, version }, lock(version), registry)).toThrow(/stable/);
  });
  it("rejects a changed package name", () => {
    expect(() => releaseDecision({ ...pkg, name: "other" }, lock(), registry)).toThrow(/name/);
  });
  it("requires both lockfile versions to match", () => {
    expect(() => releaseDecision(pkg, lock("1.1.0"), registry)).toThrow(/lockfile/);
    const bad = lock(); bad.packages[""].version = "1.1.0";
    expect(() => releaseDecision(pkg, bad, registry)).toThrow(/lockfile/);
  });
  it("rejects malformed or unexpected registry metadata", () => {
    for (const metadata of [{}, { ...registry, name: "other" }, { ...registry, versions: null }]) {
      expect(() => releaseDecision(pkg, lock(), metadata)).toThrow(/registry/);
    }
  });
  it("compares version components numerically", () => {
    expect(releaseDecision({ ...pkg, version: "1.10.0" }, lock("1.10.0"), {
      ...registry, "dist-tags": { latest: "1.9.0" },
    }).publish).toBe(true);
  });
});

describe("registry errors", () => {
  it.each([401, 404, 429, 503])("fails closed on HTTP %s", async status => {
    await expect(readRegistry(async () => new Response("error", { status }))).rejects.toThrow(String(status));
  });
  it("propagates network failures", async () => {
    await expect(readRegistry(async () => { throw new Error("network offline"); })).rejects.toThrow("network offline");
  });
});
