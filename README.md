# BitStatus

`Bitcoin · self-hosted` · `Runs on Umbrel` · `License: MIT`

<img src="./web/logo.png" width="120">

> ⚠️ **Placeholders de marca:** `web/logo.png`, `web/icon.png` e `icon.png` son los
> assets heredados del proyecto original. Sustitúyelos por tu propia marca BitStatus
> antes de publicar.

Monitoriza los saldos de tus wallets Bitcoin de forma privada, desde tu propio nodo.

BitStatus es un rastreador de saldos **watch-only** para claves extendidas **XPUB,
YPUB y ZPUB**. Deriva las direcciones **localmente** y consulta los saldos contra tu
propio **Electrs**, sin enviar tu xpub a ningún tercero.

Es un fork de [bitBalance](https://github.com/egzola/bitbalance) (de **egzola**),
reescrito para ser autocontenido, sin llamadas externas por defecto y con un frontend
sin dependencias de CDN.

---

## Por qué BitStatus

Muchos servicios de seguimiento de wallets te piden el XPUB y lo envían a sus
servidores, exponiendo todas tus direcciones, saldos e historial.

BitStatus evita esto conectándose **solo a tu propio nodo**:

```
XPUB / YPUB / ZPUB
        ↓  (derivación local de direcciones)
     BitStatus
        ↓  (TCP a tu Electrs local)
      Electrs
        ↓
   Bitcoin Core
```

Tu xpub solo viaja entre el navegador, este servidor local y Electrs. Nunca sale de tu
nodo.

---

## Dependencias de red (honesto)

Esta es la lista **real y completa** de tráfico de red que genera la app:

| Origen | Destino | ¿Cuándo? | Configurable |
|--------|---------|----------|--------------|
| Servidor BitStatus | Electrs local (TCP) | Al escanear saldos | `ELECTRUM_HOST` / `ELECTRUM_PORT` |
| Servidor BitStatus | API de precio | Solo si defines `PRICE_API_URL` | `PRICE_API_URL` (vacío = desactivado) |
| Navegador | Servidor BitStatus (mismo origen) | Siempre | — |

**Por defecto no se hace ninguna petición saliente a Internet.** El frontend no carga
ningún script de terceros: Chart.js está vendorizado en `web/vendor/` y servido
localmente. Si no defines `PRICE_API_URL`, la app funciona en **modo solo-BTC** (sin
fiat) sin contactar con nadie fuera de tu nodo.

### Precio fiat (opcional)

Para mostrar el valor en EUR/USD, apunta `PRICE_API_URL` al endpoint de precios de **tu
mempool local de Umbrel** (no a Internet):

```
PRICE_API_URL=http://<IP_mempool_local>:3006/api/v1/prices
```

El servidor (no el navegador) consulta esa URL, cachea el resultado 60 s y se lo sirve
al frontend. Se espera una respuesta tipo mempool.space: `{ "USD": 12345, "EUR": 11000 }`.
Moneda por defecto: **EUR** (con botón para alternar a USD).

---

## Tipos de wallet soportados

| Tipo | Estándar | Script | Derivación |
|------|----------|--------|-----------|
| XPUB | BIP44 | Legacy | receive(0) + change(1) |
| YPUB | BIP49 | Nested SegWit | receive(0) + change(1) |
| ZPUB | BIP84 | Native SegWit | receive(0) + change(1) |

Gap limit de 20 direcciones. Las claves se validan de verdad antes de guardarse
(prefijo + base58check + parseo con `bip32.fromBase58`).

---

## Variables de entorno

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `PORT` | `3710` | Puerto HTTP de la app |
| `ELECTRUM_HOST` | `127.0.0.1` | Host de Electrs (en Umbrel: `$APP_ELECTRS_NODE_IP`) |
| `ELECTRUM_PORT` | `50001` | Puerto TCP de Electrs (en Umbrel: `$APP_ELECTRS_NODE_PORT`) |
| `PRICE_API_URL` | *(vacío)* | Endpoint de precio fiat. Vacío = modo solo-BTC, sin red externa |

---

## Privacidad y seguridad

- Sin APIs de terceros por defecto. Sin analítica. Sin telemetría.
- El frontend no carga ningún recurso externo (Chart.js vendorizado, sin CDN).
- El nombre de wallet se **sanitiza en el servidor** (lista blanca de caracteres) y se
  renderiza en cliente con `textContent` (nunca `innerHTML`): XSS almacenado cerrado.
- Validación real de claves extendidas antes de persistir.
- Sin `eval`, `Function()`, `child_process` ni decodificación de payloads remotos en el
  código de la app.

### Nota sobre el frontend

El original cargaba **Chart.js** y **SweetAlert2** desde `cdn.jsdelivr.net`. En este
fork:

- **Chart.js 4.4.1** está vendorizado en `web/vendor/chart.umd.min.js` (sin
  `sourceMappingURL`, sin banner de jsdelivr; solo conserva su banner de licencia MIT).
- **SweetAlert2 se ha eliminado** y reemplazado por un modal/toast nativo. Motivo: las
  versiones mantenidas de SweetAlert2 (11.6+) incrustan una URL externa no configurable
  (`flag-gimn.ru/...mp3`) que puede reproducirse en runtime, lo cual es inaceptable en
  una herramienta de privacidad. El modal nativo no tiene dependencias ni URLs externas.

---

## Instalación en Umbrel

Disponible para instalar desde un Community App Store de Umbrel. Tras instalarse, se
conecta automáticamente a tu Electrs mediante `$APP_ELECTRS_NODE_IP`.

### Uso

1. Abre BitStatus.
2. Pulsa **Añadir wallet**.
3. Pon un nombre y pega un **XPUB / YPUB / ZPUB**.

El saldo se rastrea automáticamente.

---

## Desarrollo local

```bash
npm ci
ELECTRUM_HOST=127.0.0.1 ELECTRUM_PORT=50001 npm start
# abre http://localhost:3710
```

---

## Construir y publicar la imagen (GHCR)

```bash
# 1) Login en GHCR (necesita un PAT con write:packages)
echo "$GHCR_PAT" | docker login ghcr.io -u VoidHashh --password-stdin
```

### Opción A — single-arch (la imagen ya pineada en docker-compose.yml)

```bash
# 2) Build (linux/amd64 en Docker Desktop x86)
docker build -t ghcr.io/voidhashh/bitstatus:1.0.0 .

# 3) Push
docker push ghcr.io/voidhashh/bitstatus:1.0.0

# 4) Lee el digest para pinear en docker-compose.yml
docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/voidhashh/bitstatus:1.0.0
```

### Opción B — multi-arch (recomendado para Umbrel: cubre Raspberry Pi arm64 y x86)

```bash
# Construye y publica amd64 + arm64 en un único manifest-list y muestra su digest
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/voidhashh/bitstatus:1.0.0 \
  --push .

# Lee el digest del manifest-list publicado
docker buildx imagetools inspect ghcr.io/voidhashh/bitstatus:1.0.0 \
  --format '{{json .Manifest.Digest}}'
```

Copia el `@sha256:...` resultante a la línea `image:` de `docker-compose.yml`. El digest
ya pineado (`sha256:35630ac6…`) corresponde a la imagen **linux/amd64** construida y
verificada en este repo; re-pinéalo si publicas multi-arch o reconstruyes en otra máquina.

---

## Créditos

- Proyecto original: **bitBalance** por [egzola](https://github.com/egzola).
- Fork **BitStatus**, mantenido por [VoidHashh](https://github.com/VoidHashh).

## Licencia

MIT. Ver [LICENSE](./LICENSE) (se conserva la atribución a egzola).
