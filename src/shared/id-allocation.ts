const UNIQUE_ID_ATTEMPTS = 10;

export async function allocateUniqueId(
  createId: () => string,
  isAvailable: (id: string) => Promise<boolean>,
  failureMessage: string,
): Promise<string> {
  for (let attempt = 0; attempt < UNIQUE_ID_ATTEMPTS; attempt += 1) {
    const id = createId();
    if (await isAvailable(id)) return id;
  }
  throw new Error(failureMessage);
}
