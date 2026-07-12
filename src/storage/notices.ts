import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic-file.js";

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
    try {
      const text = await readFile(this.#path, "utf8");
      if (Buffer.byteLength(text, "utf8") > 16 * 1024) throw new Error("Pi Loops notice record is oversized");
      const value = JSON.parse(text) as unknown;
      if (
        typeof value !== "object" || value === null || Array.isArray(value) ||
        Object.keys(value).some((key) => key !== "schemaVersion" && key !== "subagentsRecommended") ||
        (value as Record<string, unknown>).schemaVersion !== 1 ||
        typeof (value as Record<string, unknown>).subagentsRecommended !== "boolean"
      ) {
        throw new Error("Pi Loops notice record is invalid");
      }
      return value as NoticeRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_NOTICES;
      throw error;
    }
  }
}
