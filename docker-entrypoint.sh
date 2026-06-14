#!/bin/sh
set -e

# El volumen /data de Umbrel puede montarse como propiedad de root. Arrancamos como
# root solo para corregir su propietario y, acto seguido, bajamos a 'node' para que el
# proceso de la app NO corra como root pero sí pueda escribir wallets.json.
chown -R node:node /data 2>/dev/null || true

exec su-exec node:node "$@"
