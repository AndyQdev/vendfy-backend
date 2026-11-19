# --- build -------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Las dependencias cambian mucho menos que el código: copiarlas primero
# hace que un deploy normal no reinstale nada.
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Se reinstalan solo las de producción para la imagen final
RUN npm prune --omit=dev

# --- runtime -----------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Nunca como root
RUN addgroup -S vendfy && adduser -S vendfy -G vendfy

COPY --from=build --chown=vendfy:vendfy /app/node_modules ./node_modules
COPY --from=build --chown=vendfy:vendfy /app/dist ./dist
COPY --from=build --chown=vendfy:vendfy /app/package.json ./package.json

USER vendfy
EXPOSE 3001

# El healthcheck usa el propio Nest: si la app no responde, Docker la reinicia.
# Lee PORT porque en Heroku el puerto lo asigna la plataforma en cada arranque
# (Heroku ignora este HEALTHCHECK, pero así vale para los dos mundos).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "const p=process.env.PORT||3001;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main"]
