FROM node:20-alpine

# su-exec: arrancar como root para ajustar permisos de /data y bajar a 'node'.
RUN apk add --no-cache su-exec

WORKDIR /app

# Instala dependencias primero para aprovechar la caché de capas.
COPY package*.json ./
RUN npm ci --omit=dev

# Copia el resto de la app.
COPY . .

# Entrypoint que corrige el propietario del volumen /data al arrancar.
# Normaliza a LF por si el checkout en Windows lo dejó con CRLF (rompería /bin/sh).
RUN cp docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh && \
    sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh && \
    mkdir -p /data && chown -R node:node /app /data

EXPOSE 3710

# Healthcheck ligero contra /health (wget de busybox, sin dependencias extra).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3710/health || exit 1

# Arranca como root SOLO para el chown del entrypoint; el proceso node corre como 'node'
# (el entrypoint hace 'su-exec node'). Así la app sigue sin correr como root.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
