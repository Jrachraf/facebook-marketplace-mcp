# Facebook Marketplace MCP as a standalone HTTP service (Streamable HTTP transport).
#   docker build -t facebook-marketplace-mcp .
#   docker run -p 3333:3333 -e MCP_TRANSPORT=http -e MCP_AUTH_TOKEN=... -e FACEBOOK_COOKIES_JSON=... facebook-marketplace-mcp
FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-slim
ENV NODE_ENV=production MCP_TRANSPORT=http PORT=3333 HOST=0.0.0.0 FACEBOOK_HOST=web.facebook.com
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
