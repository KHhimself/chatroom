FROM node:18-alpine

ENV NODE_ENV=production

# 設定工作目錄
WORKDIR /app

# 複製 package.json 和 package-lock.json
COPY package*.json ./

# 安裝編譯依賴（better-sqlite3 需要）
RUN apk add --no-cache python3 make g++

# 安裝依賴（使用 lockfile，僅裝 production 依賴）
RUN npm ci --omit=dev

# 複製應用程式檔案
COPY . .

# 暴露伺服器端口
EXPOSE 3000

# 啟動應用
CMD ["node", "server.js"]
