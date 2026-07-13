export interface BoundedReadableFile {
  stat(): Promise<{ size: number }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

export async function readBoundedFile(handle: BoundedReadableFile, maxBytes: number, oversizedMessage: string): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("maxBytes must be a non-negative safe integer");
  const metadata = await handle.stat();
  if (metadata.size > maxBytes) throw new Error(oversizedMessage);
  const buffer = Buffer.alloc(maxBytes + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  if (bytesRead > maxBytes) throw new Error(oversizedMessage);
  return buffer.subarray(0, bytesRead);
}
