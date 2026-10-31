FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY yh-app.json ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# 不写 USER node：/data 是平台的绑定挂载，服务器上属主是 root。server.js 以 root 启动，把 attachments 目录交给 node 后立即降权
CMD ["node", "src/server.js"]
