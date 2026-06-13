// derive.js — conversión de claves extendidas y validación.
// Todo el trabajo criptográfico es local: ninguna clave sale nunca del nodo.

const ecc = require('tiny-secp256k1')
const { BIP32Factory } = require('bip32')
const bitcoin = require('bitcoinjs-lib')

const bip32 = BIP32Factory(ecc)

// bs58check exporta distinto según versión/bundler; normalizamos el acceso.
const bs58checkModule = require('bs58check')
const bs58check = bs58checkModule.default || bs58checkModule

// Bytes de versión de un xpub de mainnet (BIP32).
const VERSION_XPUB = 0x0488b21e

// Reescribe los bytes de versión de una clave extendida a los de un xpub.
// ypub (BIP49) y zpub (BIP84) solo difieren del xpub en esos 4 bytes de cabecera:
// el material de clave pública es idéntico, así que basta con reetiquetar.
function toXpub(extKey) {
  const data = Buffer.from(bs58check.decode(extKey))
  data.writeUInt32BE(VERSION_XPUB, 0)
  return bs58check.encode(data)
}

// Conserva los nombres originales del proyecto upstream por compatibilidad.
function zpubToXpub(zpub) { return toXpub(zpub) }
function ypubToXpub(ypub) { return toXpub(ypub) }

// Valida de verdad una clave extendida y la deja lista para escanear.
// Comprueba, en orden y con mensajes claros:
//   1) prefijo soportado (xpub/ypub/zpub) -> determina el tipo de script
//   2) codificación base58check válida (al decodificar/convertir)
//   3) que bip32 sepa parsearla como clave pública extendida
// Devuelve { type, xpub, node }. Lanza Error con mensaje legible si algo falla.
function parseExtendedKey(rawKey) {
  const key = (rawKey || '').trim()

  // 1) prefijo -> tipo de dirección
  //    xpub: Legacy/BIP44 (escaneamos los tres tipos por compatibilidad)
  //    ypub: Nested SegWit/BIP49 (p2sh-p2wpkh)
  //    zpub: Native SegWit/BIP84 (p2wpkh)
  let type
  if (key.startsWith('zpub')) type = 'p2wpkh'
  else if (key.startsWith('ypub')) type = 'p2sh'
  else if (key.startsWith('xpub')) type = 'auto'
  else throw new Error('Prefijo no soportado: usa una clave xpub, ypub o zpub')

  // 2) base58check (y conversión a xpub si hace falta)
  let xpub
  try {
    xpub = type === 'auto' ? key : toXpub(key)
  } catch (e) {
    throw new Error('Codificación base58check inválida')
  }

  // 3) parseo bip32 real
  let node
  try {
    node = bip32.fromBase58(xpub, bitcoin.networks.bitcoin)
  } catch (e) {
    throw new Error('La clave no parsea como una clave extendida válida')
  }

  if (!node || !node.publicKey) {
    throw new Error('Clave extendida inválida')
  }

  return { type, xpub, node }
}

module.exports = { zpubToXpub, ypubToXpub, parseExtendedKey }
