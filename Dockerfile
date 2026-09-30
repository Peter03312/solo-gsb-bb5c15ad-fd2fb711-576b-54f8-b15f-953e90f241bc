FROM node:20-slim

# better-sqlite3 使用预编译二进制；若目标平台无预编译包，
# 安装 build-essential + python3 后会在容器内从源码编译。
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]

# 容器启动即运行 server.js：自动打开/创建 SQLite 并执行 CREATE TABLE IF NOT EXISTS，
# 依赖与首次建表随容器启动就绪。
CMD ["node", "server.js"]
