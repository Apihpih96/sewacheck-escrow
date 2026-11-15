/**
 * SHA-256 of a file computed in the browser with WebCrypto. The file never leaves the device:
 * only the 32-byte digest goes on-chain (evidence_hash / terms_hash).
 */
export async function sha256File(file: Blob): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return sha256Bytes(new Uint8Array(buf));
}

export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  // WebCrypto's subtle API only exists in secure contexts (https or localhost). Opening the dev
  // server via a LAN IP over http would otherwise fail with "cannot read properties of undefined".
  if (!globalThis.crypto?.subtle) throw new Error("File fingerprinting needs a secure (https) page. Open the app over https or on localhost.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(digest);
}

export const MAX_HASH_FILE_BYTES = 200 * 1024 * 1024;
