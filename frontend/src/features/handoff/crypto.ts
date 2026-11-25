import { HANDOFF_MAGIC, HandoffPlaintext } from "@mew/shared";

/**
 * Opens a handoff package in the browser: "NEBH1" | 12-byte nonce | AES-256-GCM ciphertext and
 * tag, with the content key the server released to this signed-in member. The plaintext stays
 * in this page's memory; nothing is stored.
 */
export async function openPackage(
  ciphertext: ArrayBuffer,
  keyB64: string,
): Promise<HandoffPlaintext> {
  const bytes = new Uint8Array(ciphertext);
  const magic = new TextEncoder().encode(HANDOFF_MAGIC);
  if (bytes.length < magic.length + 28 || magic.some((b, i) => bytes[i] !== b)) {
    throw new Error("That isn't a handoff package.");
  }
  const rawKey = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const iv = bytes.slice(magic.length, magic.length + 12);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    bytes.slice(magic.length + 12),
  );
  return HandoffPlaintext.parse(JSON.parse(new TextDecoder().decode(plain)));
}
