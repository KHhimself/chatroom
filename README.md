# WWW Chatroom Project

以 Node.js / Express / Socket.io 打造的即時聊天室，使用 PostgreSQL 儲存訊息與使用者，前端為純 HTML/CSS/Vanilla JS。支援 Email/密碼（含驗證信）與 Google OAuth 登入，圖片訊息採 S3 直傳。沒有語音/視訊通話功能。

## 功能概覽
- **登入/註冊**：Email + 密碼（需驗證 Email 後才能登入）；可選 Google OAuth。忘記密碼端點存在但尚未實作，會回傳 501。
- **聊天室**：預設群組 `group`，點擊線上名單可開啟一對一私聊。線上人數與名單以 session 去重。
- **訊息類型**：文字、Emoji、圖片（前端限制 2MB；後端對 base64 圖片設 500KB 防護）。聊天歷史一次載入最近 100 則。
- **狀態提示**：輸入中提示、加入/離開系統訊息、私聊/群聊未讀徽章。
- **資料儲存**：PostgreSQL 紀錄 users/groups/conversations/messages；啟動時確保預設群組與會話存在，並把登入者加入群組成員表。
- **使用者設定**：已登入後可於聊天室內變更暱稱（即時廣播給所有人）。

## 系統需求
- Node.js 16+（建議 18 LTS）
- PostgreSQL
- Docker / Docker Compose（可選，提供快速啟動環境）

## 快速開始

### 以 Docker 執行
```bash
# 1) 啟動 Postgres
docker compose up -d db
# 2) 建立/更新資料庫結構
docker compose run --rm chatroom npm run db:migrate
# 3) 啟動應用
docker compose up --build
# 瀏覽 http://localhost:3000
```
> 預設以 `NODE_ENV=development` 執行，Cookie secure 屬性會依環境自動調整。

### 本地開發
1) 安裝 Node（建議 18）
```bash
npm install
```
2) 設定 `.env`（見下方環境變數）。
3) 建立資料表
```bash
npm run db:migrate
```
4) 啟動
```bash
npm run dev   # 開發模式（nodemon）
# 或 npm start
```
5) 開啟 http://localhost:3000

## 主要指令
- `npm start`：啟動伺服器。
- `npm run dev`：開發模式（nodemon）。
- `npm run db:migrate`：依序套用 `migrations/*.sql`。
- `npm run db:health`：檢查 DB 連線。

## 環境變數
- `PORT`（預設 3000）
- `SESSION_SECRET`：Session 密鑰（production 必填）
- `SESSION_COOKIE_SECURE`：`true/false` 明確設定 Cookie secure 屬性（預設依 `NODE_ENV`）
- `NODE_ENV`：development / production
- `DATABASE_URL`（或 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`）
- `APP_BASE_URL`：驗證信連結基底（預設 `http://localhost:3000`）

### AWS S3（圖片直傳）
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`（若未指定會 fallback 到 us-east-1）
- `S3_BUCKET_NAME`

### Email 驗證信
- `SMTP_HOST`
- `SMTP_PORT`（587/465）
- `SMTP_USER`
- `SMTP_PASS`
- `MAIL_FROM`
未設定 SMTP 時，開發模式會將驗證信內容輸出到 console。

### Google OAuth
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL`（預設 `http://localhost:3000/auth/google/callback`）

## 使用說明
1) 在登入頁以 Email/密碼註冊；收信點擊驗證連結後才能登入。或直接用 Google 登入（需事先設定金鑰）。
2) 登入後進入 `/chat`，預設在群聊 `Group`。
3) 左側線上名單點擊任一使用者可開啟私聊；標題會顯示對方名稱。
4) 訊息框可輸入文字、選取 Emoji，或上傳圖片（前端限制 2MB，使用 S3 預簽網址上傳）。
5) 任何聊天室都會顯示輸入中提示；切換房間時會看到未讀徽章。
6) 點擊設定圖示可修改暱稱（即時同步給所有人）。忘記密碼按鈕目前僅回應「未實作」。

## 專案結構
```
hw5/
├─ server.js              # Express + Socket.io 伺服器與 API
├─ public/                # 前端靜態資源（HTML/CSS/JS）
├─ src/
│  ├─ auth.js             # Email/密碼註冊登入、Google OAuth、驗證信 token
│  ├─ db.js               # pg 連線池
│  └─ mail.js             # 驗證信寄送
├─ scripts/               # DB 工具
│  ├─ dbMigrate.js        # 套用 migrations
│  └─ dbHealth.js         # 健康檢查
├─ migrations/            # 資料表定義
├─ docker-compose.yml
├─ Dockerfile
└─ README.md
```

## 重要行為說明
- 預設群組：啟動時自動建立/確認 `group` 與對應 conversation，並把登入者加入 group_members。
- 私聊房名：`private_<sessionIdA>_<sessionIdB>`（排序後組合）；聊天歷史一次載入 100 筆。
- 圖片訊息：前端限制檔案大小 2MB；若改以 base64 上傳，後端會拒絕超過 500KB 的 payload。
- Session 儲存：使用記憶體型 session store，不適合長期生產環境。


