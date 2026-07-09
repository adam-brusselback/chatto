/**
 * End-to-end encryption for the ephemeral annotation data channel.
 *
 * LiveKit's insertable-streams E2EE protects media track frames only; data
 * channel packets (publishData) are not covered by it. To give annotations the
 * same confidentiality as the screen pixels they describe, we encrypt every
 * payload ourselves with a key derived from the per-call E2EE secret.
 *
 * The key is derived via HKDF-SHA-256 with a fixed, annotation-specific `info`
 * label, so it is cryptographically independent of the media key even though it
 * comes from the same shared secret (domain separation) — and it needs no new
 * key distribution, since the secret already reaches the client in the call
 * token.
 */

const TEXT_ENCODER = new TextEncoder();

// A fixed, non-secret salt and info label domain-separate this key from any
// other use of the call secret. The salt need not be secret for HKDF.
const HKDF_SALT = TEXT_ENCODER.encode('chatto/annotation/hkdf-salt/v1');
const HKDF_INFO = TEXT_ENCODER.encode('chatto/annotation/v1');

/** AES-GCM nonce length. 96-bit random IVs are the standard choice for GCM. */
const IV_BYTES = 12;

/**
 * Present a Uint8Array to Web Crypto as an ArrayBuffer-backed view. BufferSource
 * excludes SharedArrayBuffer-backed arrays; inputs here are ArrayBuffer-backed
 * in practice, so this is a cast in the common case and copies only a (rare)
 * SharedArrayBuffer input.
 */
function asArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

/**
 * Derive the shared AES-GCM key for annotation payloads from the per-call E2EE
 * secret (the string returned by VoiceCallService.getCallToken and handed to
 * LiveKit's key provider). Every participant derives the same non-extractable
 * key from the same secret.
 */
export async function deriveAnnotationKey(callKey: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(callKey),
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a payload, returning `IV ‖ ciphertext+tag`. A fresh random 96-bit IV
 * is generated for every call; an IV must never be reused with the same key.
 * The shared key across senders is safe here: random 96-bit IVs stay far below
 * the GCM birthday bound for any realistic call.
 */
export async function seal(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, asArrayBufferView(plaintext))
  );
  const packet = new Uint8Array(IV_BYTES + ciphertext.length);
  packet.set(iv, 0);
  packet.set(ciphertext, IV_BYTES);
  return packet;
}

/**
 * Decrypt a packet produced by {@link seal}. Returns null when the packet is
 * too short or authentication fails, so callers can simply drop bad frames.
 */
export async function open(key: CryptoKey, packet: Uint8Array): Promise<Uint8Array | null> {
  if (packet.length <= IV_BYTES) return null;
  const iv = asArrayBufferView(packet.subarray(0, IV_BYTES));
  const ciphertext = asArrayBufferView(packet.subarray(IV_BYTES));
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new Uint8Array(plaintext);
  } catch {
    return null;
  }
}
