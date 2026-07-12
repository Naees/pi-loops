import { describe, expect, it } from "vitest";
import { createCompletionContract, inferBacktickedVerifierCommands } from "../../src/contracts/completion-contract.js";

describe("completion contracts", () => {
  it("normalizes and deduplicates explicit criteria", () => {
    expect(createCompletionContract(" fix auth ", [" npm test -- auth ", "npm test -- auth"], [" no test edits "])).toEqual({
      schemaVersion: 1,
      goal: "fix auth",
      constraints: ["no test edits"],
      verifiers: [
        {
          id: "verifier_1",
          command: "npm test -- auth",
          description: "Command exits successfully: npm test -- auth",
          required: true,
        },
      ],
    });
  });

  it("only infers backticked text near verification language", () => {
    expect(inferBacktickedVerifierCommands("Keep working until `npm test` passes and run `npm run lint` successfully.")).toEqual([
      "npm test",
      "npm run lint",
    ]);
    expect(inferBacktickedVerifierCommands("Edit the `User` class.")).toEqual([]);
    expect(inferBacktickedVerifierCommands("Check `./src/file.ts` before completion.")).toEqual([]);
    expect(inferBacktickedVerifierCommands("Verify `/tmp/report.txt` exists.")).toEqual([]);
  });

  it("rejects empty goals and verifier commands", () => {
    expect(() => createCompletionContract("  ")).toThrow("Goal must not be empty");
    expect(() => createCompletionContract("goal", [""])).toThrow("Verifier command must not be empty");
  });
});
