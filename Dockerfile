# 财务管理台 · 服务器版
# 构建上下文就是本文件所在目录：
#   docker build -t fin-console .
# 或直接 docker compose up -d --build（compose 文件已配好上下文）。

FROM node:22-alpine

# node:sqlite 是 Node 内置模块，整个镜像零第三方依赖、无需编译原生模块
ENV NODE_ENV=production \
    FIN_HOST=0.0.0.0 \
    FIN_PORT=8787 \
    FIN_DATA_DIR=/data

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY frontend ./frontend

# 在镜像内构建前端，保证产物与源码同一版本。
# 构建只是把 frontend/ 复制到 public/，随后两道校验确认模块图闭合、产物结构完整。
RUN set -eu; \
    node scripts/build-frontend.mjs; \
    node scripts/check-esm.mjs; \
    node scripts/verify-build.mjs

# 数据目录独立成卷，容器重建不丢账
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8787

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FIN_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
