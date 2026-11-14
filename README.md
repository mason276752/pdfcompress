# PDF 壓縮

在瀏覽器裡把 PDF 變小：照片、掃描圖降到合適的解析度、重新壓縮，**文字和向量維持原樣**。純前端，檔案不會上傳到任何伺服器。

👉 https://mason276752.github.io/pdfcompress/

## 功能

- **壓圖片、不壓文字**：只換掉圖片，文字、向量圖形、書籤、連結、表單原封不動，壓縮後一樣可以搜尋、複製
- **看實際大小決定解析度**：同一張照片印得越小，需要的像素越少；每張圖依它畫在頁面上的大小算出有效 DPI，超過設定的才縮
- **三段壓縮程度**：輕度（200 DPI、品質 85）、建議（150 DPI、品質 75）、強力（96 DPI、品質 60），也可以自訂
- **前後對照**：壓好後同一頁並排比較，放大到 4 倍時兩邊一起捲動
- **批次處理**：一次放很多個，可以打包下載
- **有密碼的 PDF**：輸入密碼後壓縮，存回去時照原本的方式加密

## 和其他工具串接

工具都放在 `mason276752.github.io` 底下，屬於同一個 origin，可以用 [BroadcastChannel](https://developer.mozilla.org/docs/Web/API/BroadcastChannel) 互傳檔案：

- ZIP 編輯器傳來的檔案（`{type:'files'}`）會直接加進清單開始壓縮
- 這些檔案記得來源：壓好、之後改設定重壓，結果都會自動傳回（`{type:'update'}`），放在 ZIP 裡原檔旁邊、取代上一版（同一份結果連續修改時會防抖、節流：停手 0.8 秒才傳最新版，一直改也至少每 3 秒傳一次）；已經很精簡、保留原檔的不會傳
- 這裡按「傳到 ZIP 編輯器」，把全部結果打包成 ZIP 傳過去（`{type:'zip'}`），可以合併到目前的資料夾（自己加進來的檔案用這個）

對方的分頁沒開的話會自動開新分頁。協定見 [`src/bridge.js`](src/bridge.js)，與 zipeditor、paste2jpg 相同。

## 怎麼壓的

引擎是 [MuPDF](https://mupdf.com/) 官方的 WebAssembly 版（[`mupdf`](https://www.npmjs.com/package/mupdf)），在 Web Worker 裡跑。打開文件後只動圖片，最後由 MuPDF 重新存檔（`src/pdf/compress.js`）：

1. **量測**：每一頁用自訂的 Device 跑一次，記下每張圖畫在頁面上的大小（`fillImage` 的 CTM），換算成有效 DPI。沒畫出來的圖（例如只在隱藏圖層裡）當作鋪滿整頁
2. **圖片**
   - 有效 DPI 超過目標 1.25 倍的才縮小，用面積平均（`src/pdf/resample.js`），大倍率縮小也不會有摩爾紋
   - 照片重新編成 JPEG；抽樣後顏色不超過 256 種的（圖表、截圖）維持無損，不必縮的就完全不碰
   - CMYK、Lab、索引色轉成 RGB；透明圖的 SMask 跟著縮
   - 不碰：黑白（1 位元，CCITT／JBIG2 已經很省）、圖片遮罩、色鍵遮罩、特別色（Separation／DeviceN）
   - 重編後沒變小就保留原本的
3. **字型**：只留用到的字形（有表單欄位時不做，否則之後在欄位裡打字會缺字）
4. **其他**：刪掉頁面縮圖、Illustrator／InDesign 留下的 `PieceInfo`；存檔時清掉沒用到的物件、合併重複物件、壓縮所有串流、改用物件串流

整份壓完反而變大的話（本來就很精簡的檔案），下載的會是原檔。截斷或損壞的檔案 MuPDF 會盡量修復，結果會提醒你檢查頁面。

掃描檔和照片多的簡報最有效；純文字的 PDF 本來就小，能省的有限（實測約 2–10%，主要來自字型子集和物件串流）。

## 開發

```sh
npm install
npm run dev        # http://localhost:5173/pdfcompress/
npm test           # 用 MuPDF 在記憶體裡做各種 PDF，比對壓縮前後的渲染結果
npm run build      # 輸出到 dist/
```

推到 `main` 後，GitHub Actions 會跑測試、建置並發布到 GitHub Pages。

## 授權

因為使用 MuPDF（AGPL-3.0-or-later），整個專案以 **AGPL-3.0-or-later** 授權，全文見 [`LICENSE`](LICENSE)。前端使用 [Vue](https://vuejs.org/)（MIT）。
