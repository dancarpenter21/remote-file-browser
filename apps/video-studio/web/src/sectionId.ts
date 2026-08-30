interface RandomSource {
  randomUUID?: () => string;
  getRandomValues: (bytes: Uint8Array) => Uint8Array;
}

export function createSectionId(source?: RandomSource): string {
  const random = source ?? {
    randomUUID: typeof globalThis.crypto.randomUUID === "function"
      ? () => globalThis.crypto.randomUUID()
      : undefined,
    getRandomValues: (bytes: Uint8Array) => globalThis.crypto.getRandomValues(bytes),
  };
  if (random.randomUUID) return random.randomUUID();
  const bytes = random.getRandomValues(new Uint8Array(16));
  return `section-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
