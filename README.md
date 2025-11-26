# WWW Technologies & Applications 2025 — HW5 Chatroom

一個以 Node.js / Express / Socket.io / WebRTC 打造的即時聊天室。支援群聊、私聊、影像通話、圖片與表情，並提供 Email 與 Google 登入。前端是純 HTML/CSS/Vanilla JS，無框架。

## 功能概覽
- **登入**：Email/密碼（含信箱驗證）或 Google OAuth。
- **聊天室**：群聊與私聊分頁，線上人數/列表即時更新。
- **訊息**：文字、Emoji、圖片（2MB 限制，直傳 S3），輸入中提示、未讀徽章。
-, **通知**：房間/私聊訊息徽章提示。
-, **影像通話**：私聊 WebRTC；大視窗顯示對方、右下角浮窗顯示自己；通話時隱藏訊息輸入區。
- **媒體控制**：麥克風/攝影機開關具狀態顏色與圖示。

## 系統需求
- Node.js 16+（建議 18 LTS；過舊版本會因不支援 optional chaining `?.` 而報錯）
- PostgreSQL（持久化訊息、使用者與群組）
- Docker / Docker Compose（可選）

## 快速開始

### 以 Docker 執行（建議）
```bash
# 1) 啟動 Postgres
docker compose up -d db
# 2) 建立/更新資料庫結構
docker compose run --rm chatroom npm run db:migrate
# 3) 啟動應用
docker compose up --build
# 瀏覽 http://localhost:3000
```
> 提示：預設 compose 以 `NODE_ENV=development` 啟動（避免非 HTTPS 下 Cookie 被 secure 屬性擋掉）。若上線到 HTTPS，請改成 production 並確保代理設定 trust proxy。

### 本地開發
1) 安裝/切換 Node 版本（建議用 nvm）
```bash
nvm install 18
nvm use 18
node -v   # 確認至少 16，建議 18+
```
2) 安裝依賴
```bash
npm install
```
3) 設定環境變數（見下方）。先準備 `.env`。
4) 建立資料庫結構
```bash
npm run db:migrate
```
5) 啟動（開發模式）
```bash
npm run dev   # nodemon
# 或 npm start（正式模式）
```
5) 開啟 http://localhost:3000

## 主要指令
- `npm start`：啟動伺服器。
- `npm run dev`：開發模式（nodemon）。
- `npm run db:migrate`：建立/更新資料表（依序套用 `migrations/*.sql`，含 schema_migrations 紀錄）。
- `npm run db:health`：檢查 DB 連線。

## 環境變數
- `PORT`（預設 3000）
- `SESSION_SECRET`：Session 密鑰
- `NODE_ENV`：development / production
- `DATABASE_URL`（或 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`）
- `APP_BASE_URL`：驗證信連結基底（預設 `http://localhost:3000`）
### AWS S3 直傳
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `S3_BUCKET_NAME`

### Email 驗證信
- `SMTP_HOST`
- `SMTP_PORT`（587/465）
- `SMTP_USER`
- `SMTP_PASS`
- `MAIL_FROM`
未設定時，開發模式會把信件內容輸出到 console。

### Google OAuth
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL`（預設 `http://localhost:3000/auth/google/callback`）

## 使用說明
1) 登入：Email/密碼或 Google。一旦登入成功會導向 `/chat`。
2) 群聊：預設房間 `group`。
3) 私聊：左側點選使用者開始一對一；標題會顯示私人對話。
4) 傳送訊息：輸入框旁可選 Emoji 或圖片（≤2MB，直傳 S3）。
5) 通話（僅私聊）：按電話圖示開始，對方接通後大視窗顯示對方、自身浮窗在右下。通話中訊息輸入列與聊天列表隱藏，離開通話後恢復。
6) 媒體開關：麥克風/攝影機按鈕有開關圖示與顏色（藍=開、紅=關）。

## 專案結構
```
hw5/
├─ server.js              # 主要後端，Express + Socket.io + WebRTC signaling
├─ public/                # 前端靜態資源
│  ├─ index.html          # 登入/註冊頁
│  ├─ chat.html           # 聊天頁
│  ├─ css/
│  │  ├─ login.css
│  │  └─ chat.css
│  ├─ js/
│  │  ├─ login.js
│  │  └─ chat.js
│  └─ images/             # 靜態圖片、icons
├─ src/                   # 後端模組
│  ├─ auth.js             # 驗證、註冊、Google OAuth、密碼雜湊
│  ├─ db.js               # pg 連線池配置
│  └─ mail.js             # 寄信（驗證信）
├─ scripts/               # DB 工具腳本
│  ├─ dbMigrate.js        # 套用 migrations
│  └─ dbHealth.js         # 健康檢查
├─ migrations/            # 資料表定義
│  ├─ 001_init.sql
│  └─ 002_auth.sql
├─ docker-compose.yml     # Docker 服務編排
├─ Dockerfile             # 應用容器建置
└─ README.md
```

## 重要行為說明
- 預設群組：啟動時會建立/確認群組與對應 conversation。
- 私聊房名：`private_<sessionIdA>_<sessionIdB>`（排序後組合）。
- 圖片上傳：大小限制 2MB，超過會回傳錯誤提示。
- WebRTC：僅在私聊；ICE 使用 `stun:stun.l.google.com:19302`。
- UI：通話中自動切換全畫布視訊，訊息列表與輸入框隱藏；結束通話後恢復。

## 常見問題
- **視訊無法啟動**：確認 HTTPS 或 localhost，並允許瀏覽器使用相機/麥克風。
- **DB 連不到**：檢查 `DATABASE_URL` 或 PG 相關環境變數，並先執行 `npm run db:migrate`。
- **Email 驗證信未收到**：在未設定 SMTP 時會輸出到 console；正式寄送需設定 SMTP 參數或使用 Gmail App Password。

## 授權
僅供課程/作業使用。***
