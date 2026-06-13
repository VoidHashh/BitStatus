FROM node:20-alpine

WORKDIR /app

# Instala dependencias primero para aprovechar la caché de capas.
COPY package*.json ./
RUN npm ci --omit=dev

# Copia el resto de la app.
COPY . .

# Ejecuta como usuario no-root. node:20-alpine ya trae el usuario `node` (UID/GID 1000),
# que encaja con los permisos del directorio de datos de Umbrel.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3710

# Healthcheck ligero contra /health (wget de busybox, sin dependencias extra).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3710/health || exit 1

CMD ["node", "server.js"]
