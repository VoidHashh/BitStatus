// scripts.js — BitStatus (frontend)
// Sin dependencias de terceros en runtime: Chart.js está vendorizado y los
// diálogos/toasts son nativos. Los nombres de wallet SIEMPRE se pintan con
// textContent, nunca interpolados en innerHTML (cierra el XSS almacenado).

// --- Estado ---
let chart
let walletsCache = []
let totalBTC = 0
let price = { enabled: false, eur: null, usd: null }
let currency = localStorage.getItem('bitstatus.currency') === 'USD' ? 'USD' : 'EUR' // EUR por defecto

// --- Utilidades ---
function btcToSats(btc) { return Number(BigInt(Math.round(btc * 1e8))) }
function fmtBtc(btc) { return btc.toFixed(8) }

// Crea un elemento con props y, opcionalmente, hijos. Asignar props como
// .value/.textContent es seguro (no parsea HTML).
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'className') node.className = v
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else node[k] = v
  }
  for (const c of children) node.append(c)
  return node
}

// Limpieza de nombre en cliente (solo UX; el servidor es la fuente de verdad).
function cleanInput(str) {
  return String(str || '')
    .replace(/[^\p{L}\p{N} _\-.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function detectType(k) {
  if (k.startsWith('zpub')) return 'Detectado: Native SegWit (BIP84)'
  if (k.startsWith('ypub')) return 'Detectado: Nested SegWit (BIP49)'
  if (k.startsWith('xpub')) return 'Detectado: Legacy (BIP44)'
  return ''
}

async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data = {}
  try { data = await r.json() } catch {}
  if (!r.ok) throw new Error(data.error || 'Error en la petición')
  return data
}

// --- Modal nativo ---
// modal({title, buttons, setup}) -> Promise que resuelve con el `value` del
// botón pulsado (o null si se cancela). `setup({body, buttons, close})` permite
// rellenar el cuerpo y acceder a los botones por su `key`.
function modal({ title, buttons = [], setup }) {
  return new Promise(resolve => {
    let done = false
    const overlay = el('div', { className: 'modal-overlay' })
    const dialog = el('div', { className: 'modal' })
    const header = el('h2', { className: 'modal-title', textContent: title })
    const body = el('div', { className: 'modal-body' })
    const footer = el('div', { className: 'modal-footer' })

    function close(value) {
      if (done) return
      done = true
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      resolve(value)
    }
    function onKey(e) { if (e.key === 'Escape') close(null) }

    const btnMap = {}
    for (const b of buttons) {
      const btn = el('button', { className: 'btn ' + (b.kind || 'btn-ghost'), textContent: b.text })
      btn.addEventListener('click', () => close(b.value))
      if (b.key) btnMap[b.key] = btn
      footer.append(btn)
    }

    document.addEventListener('keydown', onKey)
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null) })

    dialog.append(header, body, footer)
    overlay.append(dialog)
    document.body.append(overlay)

    if (setup) setup({ body, buttons: btnMap, close })
  })
}

// --- Toast ---
function toast(message) {
  const t = el('div', { className: 'toast', textContent: message })
  document.body.append(t)
  // Forzamos reflow para que la transición de entrada se aplique.
  requestAnimationFrame(() => t.classList.add('show'))
  setTimeout(() => {
    t.classList.remove('show')
    setTimeout(() => t.remove(), 300)
  }, 1800)
}

// --- Alta de wallet ---
async function openAddModal() {
  const name = el('input', { className: 'field', maxLength: NAME_MAX, placeholder: 'Nombre de la wallet' })
  const key = el('textarea', {
    className: 'field mono', rows: 2, maxLength: 130,
    placeholder: 'XPUB / YPUB / ZPUB', spellcheck: false,
  })
  const hint = el('div', { className: 'field-hint' })
  let saveBtn

  function validate() {
    const k = key.value.trim().toLowerCase()
    const okPrefix = /^(xpub|ypub|zpub)/.test(k)
    hint.textContent = okPrefix ? detectType(k) : ''
    if (saveBtn) saveBtn.disabled = !(cleanInput(name.value) && okPrefix && k.length > 100)
  }

  const action = await modal({
    title: 'Añadir wallet',
    buttons: [
      { text: 'Cancelar', value: null, kind: 'btn-ghost' },
      { text: 'Guardar', value: 'save', kind: 'btn-primary', key: 'save' },
    ],
    setup: ({ body, buttons }) => {
      saveBtn = buttons.save
      saveBtn.disabled = true
      name.addEventListener('input', validate)
      key.addEventListener('input', validate)
      body.append(name, key, hint)
      name.focus()
    },
  })

  if (action !== 'save') return

  try {
    await postJSON('/wallet', { wallet: cleanInput(name.value), xpub: key.value.trim() })
    load(true)
  } catch (e) {
    toast(e.message)
  }
}

// --- Edición / borrado de wallet ---
async function editWallet(xpub) {
  const w = walletsCache.find(x => x.xpub === xpub)
  if (!w) return

  const name = el('input', { className: 'field', maxLength: NAME_MAX })
  name.value = w.wallet                       // asignación de propiedad: segura
  const key = el('textarea', { className: 'field mono', rows: 2, maxLength: 130 })
  key.value = w.xpub

  const action = await modal({
    title: 'Editar wallet',
    buttons: [
      { text: 'Cancelar', value: null, kind: 'btn-ghost' },
      { text: 'Eliminar', value: 'delete', kind: 'btn-danger' },
      { text: 'Guardar', value: 'save', kind: 'btn-primary' },
    ],
    setup: ({ body }) => {
      body.append(name, key)
      name.focus()
    },
  })

  if (action === null) return

  try {
    if (action === 'delete') {
      await postJSON('/wallet/remove', { xpub })
      toast('Wallet eliminada')
      return load(true)
    }

    const newKey = key.value.trim()
    await postJSON('/wallet/update', { oldXpub: xpub, wallet: cleanInput(name.value), xpub: newKey })
    // Solo reescaneamos si cambió la clave.
    load(newKey !== w.xpub)
  } catch (e) {
    toast(e.message)
  }
}

// --- Indicador de escaneo ---
let scanInterval
function startScan() {
  clearInterval(scanInterval)
  const tbody = document.querySelector('#t tbody')
  if (!tbody) return

  tbody.replaceChildren()
  const td = el('td', { colSpan: 4 })
  const cont = el('div', { className: 'scan-container' })
  const bar = el('div', { className: 'scanbar' })
  const txt = el('div', { id: 'scanIndex', textContent: 'Escaneando dirección 0' })
  cont.append(bar, txt)
  td.append(cont)
  tbody.append(el('tr', {}, td))

  let i = 0
  scanInterval = setInterval(() => {
    const elx = document.getElementById('scanIndex')
    if (elx) elx.textContent = `Escaneando dirección ${i++}`
  }, 120)
}
function stopScan() { clearInterval(scanInterval) }

// --- Carga principal ---
async function load(rescan = true) {
  startScan()

  let wallets = []
  try {
    wallets = await fetch('/wallets?rescan=' + rescan).then(r => r.json())
  } catch (e) {
    stopScan()
    console.error(e)
    return
  }

  walletsCache = wallets
  stopScan()

  const tbody = document.querySelector('#t tbody')

  if (!wallets.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 4, textContent: 'ℹ️ Aún no hay wallets configuradas' })))
    totalBTC = 0
    updateTotals()
    if (chart) chart.destroy()
    return
  }

  totalBTC = wallets.reduce((s, w) => s + w.balance, 0)
  renderRows(wallets)
  updateTotals()
  document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString()

  requestAnimationFrame(() => {
    renderChart(wallets.map(w => w.wallet), wallets.map(w => w.balance))
  })
}

// Construye las filas con DOM seguro: el nombre va por textContent.
function renderRows(wallets) {
  const tbody = document.querySelector('#t tbody')
  tbody.replaceChildren()

  for (const w of wallets) {
    const perc = totalBTC > 0 ? ((w.balance / totalBTC) * 100).toFixed(1) : '0.0'

    const tr = el('tr')
    tr.addEventListener('click', () => editWallet(w.xpub))

    const nameTd = el('td', { className: 'walletName' })
    nameTd.textContent = w.wallet            // <- render seguro

    const percTd = el('td', { className: 'percentage', textContent: perc + '%' })
    const balTd = el('td', {
      className: 'balance',
      title: btcToSats(w.balance).toLocaleString() + ' sats',
      textContent: fmtBtc(w.balance),
    })
    const chevTd = el('td', { className: 'chevron', textContent: '›' })

    tr.append(nameTd, percTd, balTd, chevTd)
    tbody.append(tr)
  }
}

// --- Totales y fiat ---
function updateTotals() {
  document.getElementById('totalTop').textContent = fmtBtc(totalBTC) + ' BTC'
  applyCurrencyUI()
}

function applyCurrencyUI() {
  const fiatEls = document.querySelectorAll('.fiat')

  if (!price.enabled) {
    fiatEls.forEach(e => { e.style.display = 'none' })
    return
  }
  fiatEls.forEach(e => { e.style.display = '' })

  const rate = currency === 'USD' ? price.usd : price.eur
  const sym = currency === 'USD' ? '$' : '€'

  const totalFiat = document.getElementById('totalFiat')
  const btcPrice = document.getElementById('btcPrice')
  const toggle = document.getElementById('currencyToggle')
  if (toggle) toggle.textContent = currency

  if (rate == null) {
    totalFiat.textContent = '—'
    btcPrice.textContent = '—'
    return
  }

  const opts = { maximumFractionDigits: 2 }
  totalFiat.textContent = sym + (totalBTC * rate).toLocaleString(undefined, opts) + ' ' + currency
  btcPrice.textContent = '1 BTC = ' + sym + rate.toLocaleString(undefined, opts) + ' ' + currency
}

async function loadPrice() {
  try {
    price = await fetch('/price').then(r => r.json())
  } catch {
    price = { enabled: false }
  }
  applyCurrencyUI()
}

function toggleCurrency() {
  currency = currency === 'EUR' ? 'USD' : 'EUR'
  localStorage.setItem('bitstatus.currency', currency)
  applyCurrencyUI()
}

// --- Chart.js (doughnut) ---
const centerText = {
  id: 'centerText',
  afterDatasetsDraw(chart) {
    const { ctx } = chart
    const meta = chart.getDatasetMeta(0)
    if (!meta.data.length) return
    const x = meta.data[0].x
    const y = meta.data[0].y
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#e6e6e6'
    ctx.font = '600 18px system-ui'
    ctx.fillText(totalBTC.toFixed(8), x, y - 8)
    ctx.fillStyle = '#9ca3af'
    ctx.font = '400 14px system-ui'
    ctx.fillText('BTC', x, y + 14)
    ctx.restore()
  },
}

const innerShadow = {
  id: 'innerShadow',
  afterDatasetsDraw(chart) {
    const { ctx } = chart
    const meta = chart.getDatasetMeta(0)
    if (!meta.data.length) return
    const x = meta.data[0].x
    const y = meta.data[0].y
    const innerRadius = meta.data[0].innerRadius
    ctx.save()
    const g = ctx.createRadialGradient(x, y, innerRadius * 0.7, x, y, innerRadius)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(0,0,0,0.35)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, innerRadius, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  },
}

function renderChart(labels, data) {
  const canvas = document.getElementById('chart').getContext('2d')
  if (chart) chart.destroy()

  chart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: [], // empieza vacío para permitir la animación de entrada
        backgroundColor: ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6'],
        borderColor: 'rgba(0,0,0,0.15)',
        borderWidth: 1,
        hoverBorderColor: '#0f1115',
        hoverOffset: 12,
        hoverBorderWidth: 3,
      }],
    },
    plugins: [centerText, innerShadow],
    options: {
      maintainAspectRatio: false,
      cutout: '72%',
      layout: { padding: { top: 16, bottom: 16, left: 16, right: 16 } },
      animation: { duration: 1200, easing: 'easeOutQuart' },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const btc = ctx.raw
              const perc = totalBTC > 0 ? ((btc / totalBTC) * 100).toFixed(2) : '0.00'
              return `${perc}%   •   ${btc.toFixed(8)} BTC`
            },
          },
        },
      },
    },
  })

  setTimeout(() => {
    chart.data.datasets[0].data = data
    chart.update()
  }, 50)
}

// --- Constantes compartidas con el servidor ---
const NAME_MAX = 45

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  const appVersion = await fetch('/appversion')
    .then(res => res.json())
    .then(data => data.appversion)
    .catch(() => '1.0.0')

  document.title = `BitStatus ${appVersion}`
  document.getElementById('app_version').textContent = `v${appVersion}`

  document.getElementById('addBtn').addEventListener('click', openAddModal)
  document.getElementById('refreshBtn').addEventListener('click', () => load(true))
  document.getElementById('currencyToggle').addEventListener('click', toggleCurrency)

  await loadPrice()
  load(false)

  // Refresca el precio cada minuto (el servidor cachea; la página no llama a terceros).
  setInterval(loadPrice, 60 * 1000)
})
