# TW 盤手｜台股 / ETF 看盤系統

**免安裝、免伺服器**的台股看盤工具。打開網址就能用，資料存在你的瀏覽器裡。

## 功能

- 加權指數 / 櫃買指數 / 台指期貨即時報價
- 個股 / ETF 詳細頁（日線圖、技術指標、五檔、新聞、三大法人）
- 自選清單（多清單、匯出入 JSON）
- 漲跌排行、投信連買、ETF 排行
- 股東會日曆
- AI 持股健檢（需自備 Groq 免費 API Key）

## 快速開始

### 1. 設定 CORS Proxy（一次性）

瀏覽器直接打台灣證交所 API 會被 CORS 擋住，需要一個免費的 Cloudflare Worker 當代理：

1. 註冊 [Cloudflare](https://dash.cloudflare.com/sign-up)（免費）
2. 進入 **Workers & Pages** → **Create** → **Create Worker**
3. 把 `worker/proxy.js` 的內容貼上去 → **Deploy**
4. 記下 Worker 網址（例如 `https://twstock-proxy.你的帳號.workers.dev`）

### 2. 開始使用

1. 打開 https://leonavibe.github.io/twstock/
2. 點「設定」→ 在「CORS Proxy URL」填入你的 Worker 網址
3. 完成！開始追蹤你的股票

### 3. 手機使用

- iPhone：Safari 打開 → 分享 → 加入主畫面
- Android：Chrome 打開 → 選單 → 加入主畫面

## AI 功能（選用）

填入 [Groq](https://console.groq.com/) 免費 API Key 即可使用：
- AI 持股健檢
- 自然語言問答

Groq 免費方案每分鐘 30 次請求，個人使用綽綽有餘。

## 資料存放

| 資料 | 位置 | 說明 |
|------|------|------|
| 自選清單 | 瀏覽器 localStorage | 只在你的裝置 |
| AI Key | 瀏覽器 localStorage | 不會上傳到任何地方 |
| 股價行情 | TWSE / TAIFEX 公開 API | 透過你的 Worker 轉發 |

## 技術細節

- 零後端：純靜態 HTML/CSS/JS
- 資料來源：TWSE MIS、TAIFEX、FinMind（全免費）
- CORS 代理：Cloudflare Workers 免費方案（10 萬次/天）
- 圖表：Canvas 手繪，無第三方套件

## 授權

MIT License
