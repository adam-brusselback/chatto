import { describe, expect, it } from 'vitest';
import { deriveAnnotationKey, open, seal } from './annotationCrypto';

const CALL_KEY = 'test-call-e2ee-secret-abcdef0123456789';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('annotationCrypto', () => {
  it('seals and opens a round trip', async () => {
    const key = await deriveAnnotationKey(CALL_KEY);
    const sealed = await seal(key, encoder.encode('hello annotation'));
    const opened = await open(key, sealed);
    expect(opened).not.toBeNull();
    expect(decoder.decode(opened!)).toBe('hello annotation');
  });

  it('derives the same key deterministically from the same secret', async () => {
    const a = await deriveAnnotationKey(CALL_KEY);
    const b = await deriveAnnotationKey(CALL_KEY);
    const sealed = await seal(a, encoder.encode('cross-key'));
    const opened = await open(b, sealed);
    expect(opened).not.toBeNull();
    expect(decoder.decode(opened!)).toBe('cross-key');
  });

  it('cannot open with a key derived from a different secret', async () => {
    const key = await deriveAnnotationKey(CALL_KEY);
    const other = await deriveAnnotationKey('a-different-call-secret');
    const sealed = await seal(key, encoder.encode('secret payload'));
    expect(await open(other, sealed)).toBeNull();
  });

  it('cannot open a tampered packet', async () => {
    const key = await deriveAnnotationKey(CALL_KEY);
    const sealed = await seal(key, encoder.encode('secret payload'));
    sealed[sealed.length - 1] ^= 0xff;
    expect(await open(key, sealed)).toBeNull();
  });

  it('uses a fresh random IV for every seal', async () => {
    const key = await deriveAnnotationKey(CALL_KEY);
    const first = await seal(key, encoder.encode('same plaintext'));
    const second = await seal(key, encoder.encode('same plaintext'));
    expect(first.subarray(0, 12)).not.toEqual(second.subarray(0, 12));
    // A fresh IV also yields different ciphertext for identical plaintext.
    expect(first).not.toEqual(second);
  });

  it('returns null for packets too short to contain an IV', async () => {
    const key = await deriveAnnotationKey(CALL_KEY);
    expect(await open(key, new Uint8Array(11))).toBeNull();
    expect(await open(key, new Uint8Array(12))).toBeNull();
  });
});
