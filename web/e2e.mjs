// Standard Web Crypto primitives, shared by the host and browser.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const encode = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export const decode = (value) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
export async function deriveKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode("relay-e2e-v1:" + secret),
    ),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export function cipher(key, context, outgoing) {
  let sent = 0,
    received = 0;
  const aad = (direction, sequence) =>
    encoder.encode(
      JSON.stringify([
        1,
        context.hostId,
        context.channelId,
        context.linkId,
        context.challenge,
        direction,
        sequence,
      ]),
    );
  return {
    async seal(value) {
      const sequence = ++sent,
        iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(outgoing, sequence) },
        key,
        encoder.encode(JSON.stringify(value)),
      );
      // Avoid spreading large payloads into a function call.
      let binary = "";
      for (const byte of new Uint8Array(data))
        binary += String.fromCharCode(byte);
      return { sequence, iv: encode(iv), data: btoa(binary) };
    },
    async open(frame) {
      if (
        frame.sequence !== received + 1 ||
        typeof frame.data !== "string" ||
        frame.data.length > 400000 ||
        typeof frame.iv !== "string"
      )
        throw Error("Invalid encrypted frame");
      const iv = decode(frame.iv);
      if (iv.length !== 12) throw Error("Invalid nonce");
      const data = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad(
            outgoing === "host" ? "client" : "host",
            frame.sequence,
          ),
        },
        key,
        decode(frame.data),
      );
      const result = JSON.parse(decoder.decode(data));
      received = frame.sequence;
      return result;
    },
  };
}
