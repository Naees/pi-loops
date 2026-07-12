export const TRUNCATION_MARKER = "\n[truncated by Pi Loops]";

export function truncateUtf8(value: string, maxBytes: number, marker = TRUNCATION_MARKER): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }

  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;

  const markerBytes = Buffer.from(marker, "utf8");
  if (markerBytes.byteLength > maxBytes) {
    return truncatePrefix(markerBytes, maxBytes);
  }

  const prefix = truncatePrefix(bytes, maxBytes - markerBytes.byteLength);
  return prefix + marker;
}

function truncatePrefix(bytes: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, bytes.byteLength);
  while (end > 0 && end < bytes.byteLength && isContinuationByte(bytes[end])) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function isContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}
