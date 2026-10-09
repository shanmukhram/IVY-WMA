/**
 * Deterministic test-vector generator.
 *
 * Writes docs/test-vectors/*.json. Every value is fixed: private keys, ephemeral
 * keys, content keys, nonces, oids, and pairing secrets are hard-coded, so the
 * output is byte-for-byte reproducible. The C# (Windows) and Kotlin (Android)
 * ports MUST reproduce these exact bytes. The vector format is documented in
 * docs/PROTOCOL.md ("Test vectors").
 *
 * Run: pnpm --filter @ivy/protocol vectors   (or: pnpm vectors from this package)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  publicKeyFromSecret,
  fingerprint,
  deriveMacKeyPair,
  sealPrivateKey,
  encryptEnvelope,
  encryptChunkedObject,
  blobManifestKey,
  blobChunkKey,
  makeOid,
  upKey,
  encodePairingString,
  encryptPairingBootstrap,
  toHex,
  toBase64,
  fromHex,
  utf8,
  type PairingPayload,
  type BootstrapPayload,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../../../docs/test-vectors");

/** Fixed byte block from a hex string (used for all "random" inputs). */
const hx = (s: string) => fromHex(s);

function write(name: string, obj: unknown): void {
  const path = resolve(OUT_DIR, name);
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  // eslint-disable-next-line no-console
  console.log("wrote", path);
}

mkdirSync(OUT_DIR, { recursive: true });

// --- Fixed key material -----------------------------------------------------
// Mac recipient secret key (32 bytes). Chosen fixed; public key derived.
const MAC_SK = hx("a1a2a3a4a5a6a7a8b1b2b3b4b5b6b7b8c1c2c3c4c5c6c7c8d1d2d3d4d5d6d7d8");
const MAC_PK = publicKeyFromSecret(MAC_SK);

// Ephemeral keypair for the single-shot envelope.
const EPH_SK = hx("11121314151617181112131415161718111213141516171811121314151617aa");
const CEK = hx("2122232425262728212223242526272821222324252627282122232425262728");
const WRAP_NONCE = hx("303132333435363738393a3b");
const BODY_NONCE = hx("404142434445464748494a4b");

// ---------------------------------------------------------------------------
// 1. Keys / fingerprint
// ---------------------------------------------------------------------------
write("keys.json", {
  description: "X25519 public-key derivation and fingerprint format.",
  macSecretKeyHex: toHex(MAC_SK),
  macPublicKeyHex: toHex(MAC_PK),
  macPublicKeyB64: toBase64(MAC_PK),
  fingerprint: fingerprint(MAC_PK),
  fingerprintFormat: "SHA-256(pubkey)[0:8] uppercase hex, grouped XXXX-XXXX-XXXX-XXXX",
});

// ---------------------------------------------------------------------------
// 2. Argon2id passphrase -> Mac keypair (determinism)
// ---------------------------------------------------------------------------
const ARGON_SALT = hx("00112233445566778899aabbccddeeff");
const derived = deriveMacKeyPair("correct horse battery staple", ARGON_SALT);
write("argon2id.json", {
  description: "Argon2id passphrase -> deterministic X25519 Mac keypair.",
  params: { algorithm: "argon2id", memoryKiB: 65536, iterations: 3, parallelism: 1, saltLen: 16, outputLen: 32 },
  passphrase: "correct horse battery staple",
  saltHex: toHex(ARGON_SALT),
  derivedSecretKeyHex: toHex(derived.secretKey),
  derivedPublicKeyHex: toHex(derived.publicKey),
  fingerprint: fingerprint(derived.publicKey),
});

// At-rest sealing uses a fixed salt+nonce via the sequential source is not used
// here (sealPrivateKey draws randomness); instead we document the derived key
// deterministically and leave at-rest round-trip to unit tests. Provide the
// Argon2id key-stretch vector for the at-rest KDF explicitly:
// (ports verify Argon2id(pass,salt) output above matches.)

// ---------------------------------------------------------------------------
// 3. Single-shot envelope
// ---------------------------------------------------------------------------
const OID1 = makeOid(1_760_000_000_000, hx("00000000000000000001"));
const OBJKEY1 = upKey("file_meta", OID1);
const PLAINTEXT1 = utf8("the robotics collaboration offer — deadline Friday");
const env1 = encryptEnvelope({
  recipientPublicKey: MAC_PK,
  kind: "file_meta",
  objectKey: OBJKEY1,
  plaintext: PLAINTEXT1,
  options: { ephemeralSecretKey: EPH_SK, contentKey: CEK, wrapNonce: WRAP_NONCE, bodyNonce: BODY_NONCE },
});
write("envelope-single.json", {
  description: "Single-shot AES-256-GCM envelope wrapped to the Mac X25519 key.",
  recipientPublicKeyHex: toHex(MAC_PK),
  recipientSecretKeyHex: toHex(MAC_SK),
  kind: "file_meta",
  objectKey: OBJKEY1,
  inputs: {
    ephemeralSecretKeyHex: toHex(EPH_SK),
    ephemeralPublicKeyHex: toHex(publicKeyFromSecret(EPH_SK)),
    contentKeyHex: toHex(CEK),
    wrapNonceHex: toHex(WRAP_NONCE),
    bodyNonceHex: toHex(BODY_NONCE),
  },
  plaintextUtf8: "the robotics collaboration offer — deadline Friday",
  plaintextHex: toHex(PLAINTEXT1),
  envelopeHex: toHex(env1),
});

// ---------------------------------------------------------------------------
// 4. Chunked object
// ---------------------------------------------------------------------------
const OID2 = makeOid(1_760_000_111_000, hx("00000000000000000002"));
const OBJID2 = hx("0a0b0c0d0e0f00112233445566778899");
const CHUNK_CEK = hx("5152535455565758515253545556575851525354555657585152535455565758");
const MANIFEST_EPH = hx("61626364656667686162636465666768616263646566676861626364656667ab");
const MANIFEST_CEK = hx("7172737475767778717273747576777871727374757677787172737475767778");
const MANIFEST_WRAP_NONCE = hx("8182838485868788898a8b8c");
const MANIFEST_BODY_NONCE = hx("9192939495969798999a9b9c");
// 600-byte deterministic payload: bytes 0..255 repeating.
const payload2 = new Uint8Array(600);
for (let i = 0; i < payload2.length; i++) payload2[i] = i & 0xff;

const chunked = encryptChunkedObject({
  recipientPublicKey: MAC_PK,
  oid: OID2,
  objectId: OBJID2,
  payloadKind: "screenshot",
  plaintext: payload2,
  chunkSize: 256,
  options: {
    contentKey: CHUNK_CEK,
    manifestEphemeralSecretKey: MANIFEST_EPH,
    manifestContentKey: MANIFEST_CEK,
    manifestWrapNonce: MANIFEST_WRAP_NONCE,
    manifestBodyNonce: MANIFEST_BODY_NONCE,
  },
});
write("envelope-chunked.json", {
  description: "Chunked object: independent AES-256-GCM chunks + binding manifest envelope.",
  recipientPublicKeyHex: toHex(MAC_PK),
  recipientSecretKeyHex: toHex(MAC_SK),
  oid: OID2,
  objectIdHex: toHex(OBJID2),
  payloadKind: "screenshot",
  chunkSize: 256,
  inputs: {
    objectContentKeyHex: toHex(CHUNK_CEK),
    manifestEphemeralSecretKeyHex: toHex(MANIFEST_EPH),
    manifestContentKeyHex: toHex(MANIFEST_CEK),
    manifestWrapNonceHex: toHex(MANIFEST_WRAP_NONCE),
    manifestBodyNonceHex: toHex(MANIFEST_BODY_NONCE),
  },
  plaintextLen: payload2.length,
  plaintextSha256Note: "payload is byte i = i mod 256, for i in [0,600)",
  manifest: chunked.manifest,
  manifestKey: blobManifestKey(OID2),
  manifestEnvelopeHex: toHex(chunked.manifestEnvelope),
  parts: chunked.parts.map((p) => ({
    key: blobChunkKey(OID2, p.index),
    index: p.index,
    bytesHex: toHex(p.bytes),
  })),
});

// ---------------------------------------------------------------------------
// 5. Pairing string + bootstrap
// ---------------------------------------------------------------------------
const PAIRING_ID = "0102030405060708090a0b0c0d0e0f10";
const PAIRING_SECRET = hx("a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf");
const BOOT_NONCE = hx("c0c1c2c3c4c5c6c7c8c9cacb");
const pairingPayload: PairingPayload = {
  v: 1,
  r2Endpoint: "https://acct.r2.cloudflarestorage.com",
  role: "windows",
  cmdBucket: "ivy-cmd-windows",
  upBucket: "ivy-up-windows",
  cmdReadToken: "CMD_READ_TOKEN_FIXED",
  macPublicKey: toBase64(MAC_PK),
  macFingerprint: fingerprint(MAC_PK),
  pairingId: PAIRING_ID,
  secret: toBase64(PAIRING_SECRET),
  exp: 1_760_000_600_000,
};
const bootstrap: BootstrapPayload = {
  v: 1,
  upBucket: "ivy-up-windows",
  upWriteToken: "UP_WRITE_TOKEN_FIXED",
  pairingId: PAIRING_ID,
};
write("pairing.json", {
  description: "Pairing string encoding + bootstrap sealed to the one-time secret.",
  pairingPayload,
  pairingString: encodePairingString(pairingPayload),
  bootstrapInputs: { secretHex: toHex(PAIRING_SECRET), nonceHex: toHex(BOOT_NONCE) },
  bootstrapPlaintext: bootstrap,
  sealedBootstrap: encryptPairingBootstrap(bootstrap, PAIRING_SECRET, { nonce: BOOT_NONCE }),
});

// eslint-disable-next-line no-console
console.log("\nAll vectors written to", OUT_DIR);
