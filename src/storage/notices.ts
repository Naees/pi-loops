import { join } from "node:path";
import { hasOnlyKeys, isRecord } from "../shared/validation.js";
import { writeJsonAtomic } from "./atomic-file.js";
import { readBoundedJsonFile } from "./json-record-files.js";

interface NoticeRecord {
  readonly schemaVersion: 1;
  readonly subagentsRecommended: boolean;
}

const DEFAULT_NOTICES: NoticeRecord = { schemaVersion: 1, subagentsRecommended: false };

export class NoticeStore {
  readonly #path: string;

  constructor(dataRoot: string) {
    this.#path = join(dataRoot, "notices.json");
  }

  async shouldShowSubagentsRecommendation(): Promise<boolean> {
    const record = await this.#read();
    return !record.subagentsRecommended;
  }

  async markSubagentsRecommendationShown(): Promise<void> {
    await writeJsonAtomic(this.#path, { schemaVersion: 1, subagentsRecommended: true } satisfies NoticeRecord);
  }

  async #read(): Promise<NoticeRecord> {
    const value = await readBoundedJsonFile(this.#path, 16 * 1024, "Pi Loops notice record is oversized");
    if (value === undefined) return DEFAULT_NOTICES;
    if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "subagentsRecommended"]) ||
      value.schemaVersion !== 1 || typeof value.subagentsRecommended !== "boolean") {
      throw new Error("Pi Loops notice record is invalid");
    }
    return { schemaVersion: 1, subagentsRecommended: value.subagentsRecommended };
  }
}
