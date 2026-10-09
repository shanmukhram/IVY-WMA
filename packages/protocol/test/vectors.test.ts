import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  publicKeyFromSecret, fingerprint, deriveMacKeyPair,
  encryptEnvelope, decryptEnvelope,
  encryptChunkedObject, decryptChunkedObject,
  encryptPairingBootstrap, decryptPairingBootstrap, decodePairingString,
  fromHex, toHex, fromBase64, utf8, fromUtf8,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const VEC = resolve(here, "../../../docs/test-vectors");
const load = (n: string) => JSON.parse(readFileSync(resolve(VEC, n), "utf8"));

describe("test vectors reproduce byte-for-byte", () => {
  it("keys.json: public key + fingerprint", () => {
    const v = load("keys.json");
    const sk = fromHex(v.macSecretKeyHex);
    expect(toHex(publicKeyFromSecret(sk))).toBe(v.macPublicKeyHex);
    expect(fingerprint(publicKeyFromSecret(sk))).toBe(v.fingerprint);
  });

  it("argon2id.json: deterministic Mac keypair", () => {
    const v = load("argon2id.json");
    const kp = deriveMacKeyPair(v.passphrase, fromHex(v.saltHex));
    expect(toHex(kp.secretKey)).toBe(v.derivedSecretKeyHex);
    expect(toHex(kp.publicKey)).toBe(v.derivedPublicKeyHex);
    expect(fingerprint(kp.publicKey)).toBe(v.fingerprint);
  });

  it("envelope-single.json: re-encrypt matches + decrypts", () => {
    const v = load("envelope-single.json");
    const env = encryptEnvelope({
      recipientPublicKey: fromHex(v.recipientPublicKeyHex),
      kind: v.kind,
      objectKey: v.objectKey,
      plaintext: fromHex(v.plaintextHex),
      options: {
        ephemeralSecretKey: fromHex(v.inputs.ephemeralSecretKeyHex),
        contentKey: fromHex(v.inputs.contentKeyHex),
        wrapNonce: fromHex(v.inputs.wrapNonceHex),
        bodyNonce: fromHex(v.inputs.bodyNonceHex),
      },
    });
    expect(toHex(env)).toBe(v.envelopeHex);
    const out = decryptEnvelope({
      recipientSecretKey: fromHex(v.recipientSecretKeyHex),
      objectKey: v.objectKey,
      envelope: fromHex(v.envelopeHex),
    });
    expect(fromUtf8(out.plaintext)).toBe(v.plaintextUtf8);
  });

  it("envelope-chunked.json: re-encrypt matches + decrypts", () => {
    const v = load("envelope-chunked.json");
    const payload = new Uint8Array(v.plaintextLen);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const res = encryptChunkedObject({
      recipientPublicKey: fromHex(v.recipientPublicKeyHex),
      oid: v.oid,
      objectId: fromHex(v.objectIdHex),
      payloadKind: v.payloadKind,
      plaintext: payload,
      chunkSize: v.chunkSize,
      options: {
        contentKey: fromHex(v.inputs.objectContentKeyHex),
        manifestEphemeralSecretKey: fromHex(v.inputs.manifestEphemeralSecretKeyHex),
        manifestContentKey: fromHex(v.inputs.manifestContentKeyHex),
        manifestWrapNonce: fromHex(v.inputs.manifestWrapNonceHex),
        manifestBodyNonce: fromHex(v.inputs.manifestBodyNonceHex),
      },
    });
    expect(toHex(res.manifestEnvelope)).toBe(v.manifestEnvelopeHex);
    res.parts.forEach((p, i) => expect(toHex(p.bytes)).toBe(v.parts[i].bytesHex));

    const parts = new Map(res.parts.map((p) => [p.index, p.bytes]));
    const out = decryptChunkedObject({
      recipientSecretKey: fromHex(v.recipientSecretKeyHex),
      manifestKey: v.manifestKey,
      manifestEnvelope: fromHex(v.manifestEnvelopeHex),
      parts,
    });
    expect(Buffer.from(out.plaintext).equals(Buffer.from(payload))).toBe(true);
  });

  it("pairing.json: string decodes + bootstrap reproduces and opens", () => {
    const v = load("pairing.json");
    const decoded = decodePairingString(v.pairingString, { now: v.pairingPayload.exp - 1 });
    expect(decoded).toEqual(v.pairingPayload);
    const sealed = encryptPairingBootstrap(
      v.bootstrapPlaintext,
      fromHex(v.bootstrapInputs.secretHex),
      { nonce: fromHex(v.bootstrapInputs.nonceHex) },
    );
    expect(sealed).toEqual(v.sealedBootstrap);
    const opened = decryptPairingBootstrap(
      v.sealedBootstrap,
      fromHex(v.bootstrapInputs.secretHex),
      v.pairingPayload.pairingId,
    );
    expect(opened.upWriteToken).toBe(v.bootstrapPlaintext.upWriteToken);
  });
});
