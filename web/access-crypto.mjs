// P-256 ECDH + HKDF + AES-GCM: browser authorization payloads stay encrypted through the relay.
import { encode, decode } from "./e2e.mjs";
const text = new TextEncoder();
export async function browserAccessKey() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return {
    privateKey: keys.privateKey,
    publicKey: encode(await crypto.subtle.exportKey("raw", keys.publicKey)),
  };
}
async function key(privateKey, remote, context) {
  const publicKey = await crypto.subtle.importKey(
    "raw",
    decode(remote),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  );
  const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: text.encode(context),
      info: text.encode("pm-browser-access-v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function wrapAccess(publicKey, context, payload) {
  const pair = await browserAccessKey(),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: text.encode(context) },
    await key(pair.privateKey, publicKey, context),
    text.encode(JSON.stringify(payload)),
  );
  return { publicKey: pair.publicKey, iv: encode(iv), data: encode(encrypted) };
}
export async function unwrapAccess(privateKey, context, envelope) {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode(envelope.iv),
      additionalData: text.encode(context),
    },
    await key(privateKey, envelope.publicKey, context),
    decode(envelope.data),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
