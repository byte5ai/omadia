#!/usr/bin/env node
/**
 * #758 — generate the Ed25519 checkpoint-signing keypair.
 *
 * Prints the PRIVATE key as base64 PKCS#8 DER (the AUDIT_SIGNING_KEY value)
 * and the PUBLIC key as PEM + fingerprint (hand the public half to auditors
 * out-of-band; pin the fingerprint). Store the private key in your secret
 * manager / env — NEVER in the database the chain defends.
 */

import { createHash, generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const fingerprint = createHash('sha256')
  .update(publicKey.export({ format: 'der', type: 'spki' }))
  .digest('hex');

console.log('AUDIT_SIGNING_KEY (private — keep in secret manager / env):\n');
console.log(privateDer.toString('base64'));
console.log('\nPublic key (share with auditors out-of-band):\n');
console.log(publicPem);
console.log(`Public key fingerprint (sha256 of SPKI DER):\n\n${fingerprint}`);
