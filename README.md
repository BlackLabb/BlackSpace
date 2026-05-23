# BlackSpace

BlackSpace 是 BlackLab 旗下的個人財務管理 Web App，核心目標是把收支、投資、預算、目標、新聞和模擬交易集中在同一個介面中管理。  
最後更新：2026-05-24

## 主要功能

- **Dashboard 總覽**
  - 顯示總支出、月均支出、銀行存款、投資總值和總資產。
  - 支援年度 / 自訂月份範圍總結。
  - 包含年度收入、年度支出、年度新增投資、年度淨現金流和年度儲蓄率。

- **Monthly View 每月視圖**
  - 按月份查看收入、支出、淨儲蓄和交易數量。
  - 支援新增、編輯、刪除交易。
  - 支援支出分類圖表、Budget vs Actual 和完整交易列表。

- **Categories 分類管理**
  - 可自訂分類名稱、顏色和每月預算。
  - 支援週期性自動交易設定。
  - 分類會用於月度統計和預算追蹤。

- **Goals 預算 / 儲蓄目標**
  - 可建立目標名稱、目標金額和已儲蓄金額。
  - 顯示目標進度和完成比例。

- **Investments 投資組合**
  - 可新增、編輯、刪除持倉。
  - 支援 USD、HKD、EUR、GBP、JPY。
  - 透過 Cloudflare Worker 取得即時或近即時報價。
  - 顯示 Total Cost、Market Value、Total P&L、Return、Capital、Cash Remaining 和 Account Value。
  - 顯示 Portfolio Allocation，包含股票、ETF、Crypto、Bond、Cash 等分類。

- **Investment News 投資新聞**
  - 內建投資新聞頁面與獨立 `news.html` 測試頁。
  - 透過 Cloudflare Worker `/news` endpoint 讀取公司相關新聞。
  - 支援 ticker 搜尋、watchlist chip、排序、情緒分數和公司相關性過濾。
  - Worker 可使用 Finnhub 取得公司新聞，並可接入 DeepSeek 做情緒 / 股價影響分析。

- **Sim Trading / BlackInvest 模擬交易**
  - 程式內包含模擬交易模組。
  - 支援 watchlist、持倉、訂單、限價單、市價買賣、買賣記錄和起始資金設定。
  - 目前入口在部分 UI 中屬於隱藏 / 實驗狀態。

- **登入與同步**
  - 使用 Firebase Authentication。
  - 使用 Firestore 儲存用戶資料。
  - 支援註冊、登入、登出、修改密碼。
  - 登入失敗過多會有短暫 lockout 保護。

- **PWA / iOS Web App 支援**
  - 支援 `viewport-fit=cover`。
  - 已處理 iOS PWA status bar / bottom safe area / keyboard 後白邊問題。
  - 可加入主畫面作為類 App 使用。


## 備份與資料
App 內有 JSON 匯出 / 匯入功能，可用於手動備份資料。登入後資料會以 Firebase Firestore 作主要同步來源。

## 免責聲明
BlackSpace 的投資、新聞和模擬交易功能只供學習、記錄和分析用途，不構成任何投資建議。所有市場資料、新聞內容和情緒分析都可能延遲或出錯，使用者應自行核實資料。投資涉及風險，包括可能損失本金。BlackSpace 並非持牌證券交易商。
