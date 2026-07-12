export function isCanonicalIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function isBoundedNonEmptyStringArray(
  value: unknown,
  maximumItems: number,
  maximumItemBytes: number,
): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) =>
    typeof item === "string" && item.trim().length > 0 && Buffer.byteLength(item, "utf8") <= maximumItemBytes);
}
