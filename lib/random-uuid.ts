// crypto.randomUUID exists only in secure contexts (HTTPS or localhost).
// The LAN deployment is plain HTTP, where getRandomValues still exists.

type FillRandom = (bytes: Uint8Array) => Uint8Array;

type Uuid = `${string}-${string}-${string}-${string}-${string}`;

type CryptoLike = {
  getRandomValues?: FillRandom;
  randomUUID?: () => string;
};

export function randomUuidV4(fillRandom: FillRandom): Uuid {
  const bytes = fillRandom(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function installRandomUuidFallback(
  target: CryptoLike | undefined = globalThis.crypto
): void {
  if (typeof target?.getRandomValues !== "function") return;
  if (typeof target.randomUUID === "function") return;
  const fillRandom = target.getRandomValues.bind(target);
  target.randomUUID = () => randomUuidV4(fillRandom);
}
