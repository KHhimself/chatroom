#!/bin/bash

echo "啟動聊天室伺服器..."

# 檢查是否安裝了 Node.js
if ! command -v node &> /dev/null
then
    echo "錯誤：未安裝 Node.js"
    echo "請先安裝 Node.js: https://nodejs.org/"
    exit 1
fi

# 檢查是否安裝了依賴套件
if [ ! -d "node_modules" ]; then
    echo "安裝依賴套件..."
    npm install
fi

# 啟動伺服器
echo "伺服器啟動在 http://localhost:3000"
npm start 