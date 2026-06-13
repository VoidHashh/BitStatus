// server.js — BitStatus
// Servidor Express mínimo: sirve los estáticos de /web, deriva direcciones
// localmente y consulta saldos contra un Electrs local por TCP.
// El xpub solo viaja entre el navegador, este servidor y Electrs (TCP local).

const express = require('express')
const fs = require('fs')
const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const ElectrumClient = require('electrum-client')

const { parseExtendedKey } = require('./derive')

const isDocker = fs.existsSync('/.dockerenv')
const appVersion = require('./package.json').version || '1.0.0'

// --- Configuración (todo por entorno; valores por defecto seguros) ---
const HOST = process.env.ELECTRUM_HOST || '127.0.0.1'
const ELECTRUM_PORT = parseInt(process.env.ELECTRUM_PORT || '50001', 10)
const APP_PORT = parseInt(process.env.PORT || '3710', 10)

// Precio fiat OPCIONAL. Vacío = modo solo-BTC, sin ninguna petición saliente.
// Apúntalo a tu mempool local de Umbrel, p.ej. http://10.21.x.x:3006/api/v1/prices
const PRICE_API_URL = process.env.PRICE_API_URL || ''

const DATA_DIR = isDocker ? '/data' : __dirname + '/data'
const DATA_FILE = DATA_DIR + '/wallets.json'

const GAP_LIMIT = 20      // direcciones vacías consecutivas antes de parar
const CONCURRENCY = 10    // direcciones consultadas en paralelo por lote
const NAME_MAX = 45       // longitud máxima del nombre de wallet

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static('web'))

let wallets = []
let electrum = null

// --- Persistencia ---
try {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]')
} catch (e) {
  console.error('Error inicializando almacenamiento:', e)
}

try {
  wallets = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '[]')
} catch (e) {
  console.error('Error leyendo wallets.json:', e)
  wallets = []
}

function saveWallets() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(wallets, null, 2))
}

function loadWallets() {
  try {
    wallets = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  } catch {
    wallets = []
  }
}

// Sanitiza el nombre de wallet en el SERVIDOR (fuente de verdad).
// Lista blanca de caracteres: letras y números unicode, espacio, _ - . —
// con eso es imposible inyectar HTML/JS aunque alguien haga POST directo a la API.
function sanitizeName(raw) {
  return String(raw || '')
    .replace(/[^\p{L}\p{N} _\-.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
}

// --- Electrum (Electrs local) ---
async function connectElectrum() {
  try {
    electrum = new ElectrumClient(ELECTRUM_PORT, HOST, 'tcp')
    electrum.onClose = () => {
      console.log('Electrum desconectado, reintentando...')
      setTimeout(connectElectrum, 5000)
    }
    await electrum.connect()
    await electrum.server_version('BitStatus', '1.4')
    console.log('Electrum conectado')
  } catch (e) {
    console.error('Error conectando a Electrum:', e.message)
    setTimeout(connectElectrum, 5000)
  }
}

function withTimeout(p, ms = 5000) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

// Electrum indexa por "script hash": sha256 del scriptPubKey, en bytes invertidos.
function addressToScriptHash(address) {
  const script = bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin)
  const hash = crypto.createHash('sha256').update(script).digest()
  return Buffer.from(hash.reverse()).toString('hex')
}

async function getAddressBalance(address) {
  const sh = addressToScriptHash(address)
  const utxos = await electrum.blockchainScripthash_listunspent(sh)
  if (!utxos || utxos.length === 0) return 0
  return utxos.reduce((total, u) => total + u.value, 0)
}

// Escanea una rama (receive=0 o change=1) de un tipo de script concreto.
// Avanza por lotes hasta acumular GAP_LIMIT direcciones vacías seguidas.
// Devuelve el total de la rama en BTC.
async function scanBranch(root, change, type) {
  const branch = root.derive(change)

  let index = 0
  let gap = 0
  let totalSats = 0

  while (gap < GAP_LIMIT) {
    const batch = []

    for (let i = 0; i < CONCURRENCY; i++) {
      const child = branch.derive(index)
      let payment

      if (type === 'p2wpkh') {
        payment = bitcoin.payments.p2wpkh({
          pubkey: child.publicKey,
          network: bitcoin.networks.bitcoin,
        })
      } else if (type === 'p2sh') {
        payment = bitcoin.payments.p2sh({
          redeem: bitcoin.payments.p2wpkh({
            pubkey: child.publicKey,
            network: bitcoin.networks.bitcoin,
          }),
        })
      } else if (type === 'p2pkh') {
        payment = bitcoin.payments.p2pkh({
          pubkey: child.publicKey,
          network: bitcoin.networks.bitcoin,
        })
      }

      if (!payment) throw new Error('Tipo de dirección inválido')

      batch.push(payment.address)
      index++
    }

    const balances = await Promise.all(
      batch.map(a => withTimeout(getAddressBalance(a)).catch(() => 0))
    )

    for (const balance of balances) {
      if (balance > 0) gap = 0
      else gap++
      totalSats += balance
    }

    // Pequeña pausa para no saturar Electrs con ráfagas seguidas.
    await new Promise(r => setTimeout(r, 10))
  }

  return totalSats / 1e8
}

// Saldo total de una clave extendida sumando ramas receive(0) y change(1).
// Un xpub puede haberse usado con cualquiera de los tres esquemas, así que
// escaneamos los tres; ypub/zpub fijan un único tipo.
async function getWalletBalance(key) {
  let total = 0
  try {
    const { type, node } = parseExtendedKey(key)
    const types = type === 'auto' ? ['p2pkh', 'p2wpkh', 'p2sh'] : [type]

    for (const t of types) {
      total += await scanBranch(node, 0, t)
      total += await scanBranch(node, 1, t)
    }
  } catch (e) {
    console.error('Error escaneando wallet:', e.message)
    total = 0
  }
  return total
}

// --- Precio fiat (opcional, server-side) ---
// Se consulta desde el servidor (no desde el navegador) para que la página no
// haga ninguna petición a terceros. Cacheado para no martillear el mempool local.
let priceCache = { time: 0, eur: null, usd: null }
const PRICE_TTL = 60 * 1000

function pickNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

async function fetchPrice() {
  if (!PRICE_API_URL) return { enabled: false }

  const now = Date.now()
  if (now - priceCache.time < PRICE_TTL && (priceCache.eur != null || priceCache.usd != null)) {
    return { enabled: true, eur: priceCache.eur, usd: priceCache.usd, time: priceCache.time }
  }

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const r = await fetch(PRICE_API_URL, { signal: ctrl.signal })
    clearTimeout(t)
    const data = await r.json()
    // Tolerante a esquemas tipo mempool.space: { "USD": ..., "EUR": ... }
    priceCache = {
      time: now,
      eur: pickNumber(data.EUR ?? data.eur),
      usd: pickNumber(data.USD ?? data.usd),
    }
    return { enabled: true, eur: priceCache.eur, usd: priceCache.usd, time: priceCache.time }
  } catch (e) {
    console.error('Error consultando precio:', e.message)
    // Degradamos a lo último conocido (o null) sin romper el front.
    return { enabled: true, eur: priceCache.eur, usd: priceCache.usd, error: true }
  }
}

// --- API ---
app.get('/appversion', (req, res) => {
  res.json({ appversion: appVersion })
})

app.get('/health', (req, res) => {
  res.json({ ok: true })
})

app.get('/price', async (req, res) => {
  res.json(await fetchPrice())
})

app.get('/wallets', async (req, res) => {
  const rescan = req.query.rescan === 'true'

  loadWallets()

  if (rescan) {
    // Secuencial a propósito: en paralelo se satura Electrs y aparecen timeouts.
    for (const w of wallets) {
      w.balance = await getWalletBalance(w.xpub)
    }
    saveWallets()
  }

  wallets.sort((a, b) => a.wallet.localeCompare(b.wallet))
  res.json(wallets)
})

app.post('/wallet', (req, res) => {
  const wallet = sanitizeName(req.body.wallet)
  const rawXpub = (req.body.xpub || '').trim()

  if (!wallet) return res.status(400).json({ error: 'Falta el nombre de la wallet' })
  if (!rawXpub) return res.status(400).json({ error: 'Falta la clave xpub/ypub/zpub' })

  // Validación real de la clave antes de guardar nada.
  let xpub
  try {
    parseExtendedKey(rawXpub)
    xpub = rawXpub
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  if (wallets.some(w => w.xpub === xpub)) {
    return res.status(400).json({ error: 'Esa clave ya está añadida' })
  }

  const id = wallets.length > 0 ? Math.max(...wallets.map(w => w.id)) + 1 : 0
  const order = wallets.length

  wallets.push({ id, order, wallet, xpub, balance: 0 })
  saveWallets()

  res.json({ ok: true })
})

app.post('/wallet/remove', (req, res) => {
  const xpub = (req.body.xpub || '').trim()
  if (!xpub) return res.status(400).json({ error: 'Falta la clave a eliminar' })

  wallets = wallets.filter(w => w.xpub !== xpub)
  saveWallets()

  res.json({ ok: true })
})

app.post('/wallet/update', (req, res) => {
  const oldXpub = (req.body.oldXpub || '').trim()
  const wallet = sanitizeName(req.body.wallet)
  const rawXpub = (req.body.xpub || '').trim()

  if (!oldXpub || !wallet || !rawXpub) {
    return res.status(400).json({ error: 'Datos incompletos' })
  }

  let xpub
  try {
    parseExtendedKey(rawXpub)
    xpub = rawXpub
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const index = wallets.findIndex(w => w.xpub === oldXpub)
  if (index === -1) return res.status(404).json({ error: 'Wallet no encontrada' })

  if (wallets.some(w => w.xpub === xpub && w.xpub !== oldXpub)) {
    return res.status(400).json({ error: 'Esa clave ya está añadida' })
  }

  wallets[index].wallet = wallet
  wallets[index].xpub = xpub
  saveWallets()

  res.json({ ok: true })
})

// --- Arranque ---
async function start() {
  await connectElectrum()
  app.listen(APP_PORT, () => {
    console.log(`BitStatus escuchando en el puerto ${APP_PORT}`)
    console.log(`Versión: ${appVersion}`)
    console.log(`Precio fiat: ${PRICE_API_URL ? 'activado' : 'desactivado (modo solo-BTC)'}`)
  })
}

start()
