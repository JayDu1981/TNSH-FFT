# 手機收音檢測（mic-check）

高二自然組「簡易樂器 + FFT 頻譜分析」課程的第一步驗證：在學生手機上用網頁收音，聲音會不會被手機系統自動修改（自動增益、降噪、回音消除）？

| 頁面 | 給誰 | 用途 |
|---|---|---|
| `index.html` | 學生手機 | 收音檢查、A／B 兩回合錄音與分析、重播、上傳結果 |
| `source.html` | 老師筆電 | 播放標準測試音、課前準備與上課流程、學生網址 QR code |
| `aggregate.html` | 老師電腦 | 匯入全班結果檔，總覽與匯出 CSV |

- A 模式：`getUserMedia({audio: true})`，用手機預設的收音處理。
- B 模式：`echoCancellation / noiseSuppression / autoGainControl` 全部設為 `false`。

測試程序約 28 秒，依序為：2 kHz 提示音（手機據此自動對時）、1 kHz 音量階梯（−12／−22／−32 dBFS）、4 秒安靜、440 Hz 複合音（8 個泛音，第 n 個振幅 1/n）、200 Hz→12 kHz 對數掃頻。內容定義在 `program.js`，分析在 `analysis.js`。

所有運算都在瀏覽器內進行，不需要伺服器。
