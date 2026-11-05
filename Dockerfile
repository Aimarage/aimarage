FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx nuxt prepare && npx nuxt build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev && npm cache clean --force

FROM node:24-alpine
WORKDIR /app
ENV HOSTED=false NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data/pglite MEDIA_DIR=/app/data/media APP_SECRET_FILE=/app/data/app-secret
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/.output ./.output
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/worker ./worker
COPY --from=build /app/scripts ./scripts
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/favicon.svg').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
