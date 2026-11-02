# memHub web server + REST API. Zero build step; the only runtime dep is the
# optional local embedding model (@xenova/transformers -> onnxruntime-node,
# which needs glibc: use -slim, NOT alpine/musl, or embeddings silently die).
# MCP stays OUT of the image: it's stdio, agents run it on the host against
# the same store.json (bind-mounted) - see docker-compose.yml + README.
FROM node:24-slim

ENV NODE_ENV=production
ENV MEMHUB_PORT=4777
ENV MEMHUB_BIND=0.0.0.0
ENV MEMHUB_DATA=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ server/
COPY web/ web/
RUN mkdir -p /data

EXPOSE 4777

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4777/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
