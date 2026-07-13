import { describe, expect, it, vi } from "vitest";
import { readBoundedFile, type BoundedReadableFile } from "../../src/storage/bounded-file-reader.js";

describe("bounded file reader", () => {
  it("rejects growth beyond the ceiling even when stat reports a smaller file", async () => {
    const contents = Buffer.from("12345", "utf8");
    let cursor = 0;
    const handle: BoundedReadableFile = {
      stat: vi.fn(async () => ({ size: 2 })),
      read: vi.fn(async (buffer, offset, length) => {
        const bytesRead = Math.min(length, contents.length - cursor);
        contents.copy(buffer, offset, cursor, cursor + bytesRead);
        cursor += bytesRead;
        return { bytesRead };
      }),
    };

    await expect(readBoundedFile(handle, 4, "too large")).rejects.toThrow("too large");
    expect(handle.read).toHaveBeenCalledTimes(1);
    expect(handle.read).toHaveBeenCalledWith(expect.any(Buffer), 0, 5, 0);
  });

  it("stops reading at EOF and returns only initialized bytes", async () => {
    const handle: BoundedReadableFile = {
      stat: vi.fn(async () => ({ size: 2 })),
      read: vi.fn()
        .mockImplementationOnce(async (buffer: Buffer) => {
          buffer.write("ok");
          return { bytesRead: 2 };
        })
        .mockResolvedValueOnce({ bytesRead: 0 }),
    };
    await expect(readBoundedFile(handle, 4, "too large")).resolves.toEqual(Buffer.from("ok"));
  });
});
