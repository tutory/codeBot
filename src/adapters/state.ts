import fs from "node:fs";

import type { TaskRecord } from "../domain/models.js";

export class StateStore {
  constructor(private readonly filePath: string) {}

  load(): Map<number, TaskRecord> {
    if (!fs.existsSync(this.filePath)) {
      return new Map();
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<
      string,
      TaskRecord
    >;
    return new Map(
      Object.entries(raw).map(([issueNumber, record]) => [Number(issueNumber), record])
    );
  }

  save(records: ReadonlyMap<number, TaskRecord>): void {
    const payload = Object.fromEntries(
      [...records.entries()]
        .sort(([left], [right]) => left - right)
        .map(([issueNumber, record]) => [String(issueNumber), record])
    );
    fs.writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
