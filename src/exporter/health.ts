import fs from "node:fs";
import path from "node:path";
import type { ExportResult } from "./exporter.js";

interface HealthState {
  started_at: string;
  last_cycle_at?: string;
  last_success_at?: string;
  last_error?: string;
}

/** Independent of the mirror manifest: rendering locally does not prove publication. */
export class ExporterHealth {
  private state: HealthState;

  constructor(private file: string, private now: () => Date = () => new Date()) {
    this.state = { started_at: this.now().toISOString() };
    this.persist();
  }

  record(result: ExportResult): void {
    this.state.last_cycle_at = this.now().toISOString();
    this.state.last_error = result.error;
    if (result.pushed && !result.error) this.state.last_success_at = this.state.last_cycle_at;
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
