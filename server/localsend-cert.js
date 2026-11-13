import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * The identity this PC shows to phones over LocalSend: an RSA key and a
 * self-signed certificate, made once and kept, so a phone that has seen the
 * PC before recognises it again.
 *
 * LocalSend devices identify each other by the SHA-256 of the certificate
 * (in DER form, as uppercase hex), checked during the encrypted handshake,
 * so no certificate authority is involved. Node can read certificates but not
 * make them, so the few ASN.1 structures a certificate needs are written out
 * here by hand.
 */

// DER: a tag, a length, then the contents.
function tlv (tag, body) {
  const n = body.length
  const len = n < 0x80
    ? Buffer.from([n])
    : n < 0x100 ? Buffer.from([0x81, n])
      : n < 0x10000 ? Buffer.from([0x82, n >> 8, n & 0xff])
        : Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff])
  return Buffer.concat([Buffer.from([tag]), len, body])
}
const seq = (...parts) => tlv(0x30, Buffer.concat(parts))
const set = (...parts) => tlv(0x31, Buffer.concat(parts))
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf)
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split('.').map(Number)
  const bytes = [a * 40 + b]
  for (const v of rest) {
    const chunk = [v & 0x7f]
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80)
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'))
const utcTime = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'))
const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]))
const explicit = (n, body) => tlv(0xa0 + n, body)

const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]))

/** A fresh RSA-2048 key and a self-signed certificate for it, both PEM. */
export function makeIdentity (name = 'Video Splitter') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const subject = seq(set(seq(oid('2.5.4.3'), utf8(name))))
  const now = Date.now()
  // A random positive serial number with no leading zero byte.
  const serial = crypto.randomBytes(16)
  serial[0] = (serial[0] & 0x7f) | 0x01
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))), // version 3
    int(serial),
    SHA256_RSA,
    subject, // issuer: itself
    seq(utcTime(new Date(now - 24 * 3600 * 1000)), utcTime(new Date('2049-12-31T23:59:59Z'))),
    subject,
    publicKey.export({ type: 'spki', format: 'der' })
  )
  const signature = crypto.sign('sha256', tbs, privateKey)
  const der = seq(tbs, SHA256_RSA, bitString(signature))
  const cert = '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n'
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

/** The LocalSend fingerprint of a PEM certificate. */
export const fingerprintOf = (certPem) => new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, '').toUpperCase()

/** This PC's identity, made on first use and kept in `dir`. */
export async function loadIdentity (dir) {
  const certFile = path.join(dir, 'cert.pem')
  const keyFile = path.join(dir, 'key.pem')
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const cert = await fsp.readFile(certFile, 'utf8')
    const key = await fsp.readFile(keyFile, 'utf8')
    try {
      if (new crypto.X509Certificate(cert).checkPrivateKey(crypto.createPrivateKey(key))) return { cert, key, fingerprint: fingerprintOf(cert) }
    } catch { /* unreadable: make a new one */ }
  }
  const made = makeIdentity()
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(keyFile, made.key, { mode: 0o600 })
  await fsp.writeFile(certFile, made.cert)
  return { ...made, fingerprint: fingerprintOf(made.cert) }
}
