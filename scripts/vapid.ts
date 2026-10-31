// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Prints a VAPID key pair for web push: the public key (base64url, uncompressed P-256 point) and the
// private key (base64url, the JWK `d`).
const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
console.log(`VAPID_PUBLIC_KEY=${b64url(pub)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
