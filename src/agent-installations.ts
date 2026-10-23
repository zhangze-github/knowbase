import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const CONTEXT_OWNER = "knowbase-agent-context-v1";

/** A config created only to enable our plugin is not independent install evidence. */
export function hermesConfigIsGenerated(dir: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, "plugins/knowbase-context/.knowbase.json"), "utf8"));
    return marker.owner === CONTEXT_OWNER && typeof marker.createdConfigHash === "string" &&
      marker.createdConfigHash === createHash("sha256").update(fs.readFileSync(path.join(dir, "config.yaml"))).digest("hex");
  } catch { return false; }
}

export interface AdditionalAgentHome {
  name: "Cursor" | "Hermes";
  dir: string;
}

/** Only client-owned state counts; our context, hooks, plugins and skills never do. */
function hasInstallMarker(dir: string, markers: string[]): boolean {
  try {
    return fs.readdirSync(dir).some(name => markers.includes(name));
  } catch {
    return false;
  }
}

export function hermesHomeDir(home = os.homedir(), value = process.env.HERMES_HOME): string {
  const configured = value?.trim();
  return configured
    ? path.resolve(configured === "~" ? home : configured.startsWith("~/") ? path.join(home, configured.slice(2)) : configured)
    : path.join(home, ".hermes");
}

export function additionalAgentHomes(home: string, includeUninstalled = false, hermesHome?: string): AdditionalAgentHome[] {
  const candidates: Array<AdditionalAgentHome & { markers: string[] }> = [
    { name: "Cursor", dir: path.join(home, ".cursor"), markers: ["cli-config.json", "ide_state.json", "extensions", "projects"] },
    { name: "Hermes", dir: hermesHomeDir(home, hermesHome), markers: ["config.yaml", ".env", "sessions", "state.db"] },
  ];
  return candidates
    .filter(t => includeUninstalled || hasInstallMarker(t.dir,
      t.name === "Hermes" && hermesConfigIsGenerated(t.dir) ? t.markers.filter(m => m !== "config.yaml") : t.markers))
    .map(({ name, dir }) => ({ name, dir }));
}
