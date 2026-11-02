# WPCD 頸圈對接規格 v1

本文件是前端與頸圈韌體的對接契約。PWA 已預留真實 Web Bluetooth 通道、通知解析、資料驗證、斷線狀態及明確標示的模擬器；尚未取得實際頸圈的 GATT 規格，也尚未完成實機驗證。配對成功不代表量測準確，量測結果亦不構成醫療診斷。

## 1. 串接前須向硬體端取得的資料

- 裝置名稱規則、硬體與韌體版本。
- GATT Service UUID、提供通知的 Characteristic UUID，以及該特徵支援 `notify` 或 `indicate` 的確認。裝置廣播須包含指定 Service UUID，因為選擇器使用服務篩選。
- BLE 安全設定：是否需要配對／綁定、加密連線、使用者認證與裝置身分驗證。
- 通知頻率、MTU／分片策略、離線緩存、校時與重傳策略。
- 每項量測的感測器、單位、演算法版本、有效範圍及品質判斷方式。

Service 與 Characteristic UUID 必須使用硬體端提供的值；本產品沒有可套用所有頸圈的通用 UUID。前端目前讀取通知，不提供韌體升級、寫入控制命令或裝置密鑰交換。

## 2. 傳輸與封包邊界

BLE Characteristic 通知的內容為 UTF-8 編碼的 JSON，每個 JSON 物件後接一個換行位元組 `\n`。JSON 單行內容不得超過 16 KiB，不包含結尾 LF；若傳送 CRLF，CR 仍計入行內長度。接收端必須處理單筆訊息跨多個通知，以及同一通知包含多筆訊息的情況。

韌體可依協商的 MTU 分片；不得將每次通知視為完整 JSON。若分片切在多位元 UTF-8 字元中間，接收端需使用串流解碼器保留未完整的位元組。不要送出漂亮排版的多行 JSON，換行只作為訊息分隔。傳送端可使用 `encodePacket()` 產生單行訊息。

超出長度、無法解析、時間或數值不合法的訊息會遭拒絕，不能默默轉成正常讀數。正式韌體還需約定錯誤回報、重傳與資料品質旗標；本版 v1 沒有把缺失資料視為零。

## 3. 資料格式

```json
{
  "schemaVersion": 1,
  "deviceId": "WPCD-000123",
  "sequence": 12481,
  "recordedAt": "2026-11-02T08:15:00.000Z",
  "metrics": {
    "activityMinutes": 43,
    "restMinutes": 365,
    "scratchCount": 8,
    "surfaceTemperatureC": 34.8,
    "batteryPercent": 86
  }
}
```

| 欄位 | 契約 |
| --- | --- |
| `schemaVersion` | 固定為整數 `1`。 |
| `deviceId` | 1–64 字元，符合 `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`。使用穩定識別碼，不要隨重啟改名。 |
| `sequence` | 非負 JavaScript 安全整數；每個裝置持續單調遞增。 |
| `recordedAt` | 含時區的 ISO 8601／RFC 3339 時間，建議傳 UTC `Z`。不可超過接收端現在時間五分鐘。 |
| `metrics` | 至少包含下表一個支援的有限數值。未知量測欄位會拒絕整筆封包；未知頂層欄位會忽略。缺失表示未提供，不代表零。 |

| 量測欄位 | 單位及 v1 語意 | 接收範圍 |
| --- | --- | --- |
| `activityMinutes` | `recordedAt` 所在 **UTC 日**，自 00:00 起的活動分鐘累計值。 | 0–1440 |
| `restMinutes` | 同一 UTC 日自 00:00 起的休息分鐘累計值。靜止／休息估計不等於已確認睡眠。 | 0–1440 |
| `scratchCount` | 同一 UTC 日自 00:00 起的搔抓事件累計值。 | 0–100000 |
| `surfaceTemperatureC` | 該筆時間的體表溫度，攝氏。受環境、毛髮及配戴影響，不能當成核心體溫或發燒判定。 | 15–50 |
| `heartRateBpm` | 該筆時間的心率，次／分鐘；僅供完成感測及演算法驗證的真實硬體使用。本版模擬器不送此欄位。 | 30–350 |
| `batteryPercent` | 該筆時間的電量百分比。 | 0–100 |

範圍只是輸入驗證，並非貓咪正常值。同筆封包若同時提供活動及休息分鐘，合計不得超過 1440，超過會拒絕。活動、休息與搔抓為每日累計，不是這一個通知期間的增量；顯示端必須以當日最新值更新，不能把每筆再加總。UTC 日切換時累計值歸零，序號仍須繼續增加。介面顯示本地時間時亦不得改變封包所屬的 UTC 統計日；若未來改成本地日，須提升契約版本並明定時區。

目前 bridge 生命週期內會為每個 `deviceId` 忽略已接收序號及較小序號，最多保留 128 個裝置的序號游標。這個模組沒有 storage 依賴，重載頁面或重新建立 bridge 後不會保留去重狀態；產品儲存層須自行持久保存各裝置的封包游標，並在保存前再次去重，才能處理跨重新載入的補送。序號不得因韌體重啟歸零；正式裝置需持久化計數，或另行設計帶有工作階段識別的新版本協定。數值有效不代表感測資料可信，仍需驗證裝置身分、韌體來源與量測品質。

接收後的 `measurement` 事件會加上由傳輸端決定的 `source`：`ble`、`simulator` 或 `manual`。它不應由韌體自行宣告。`manual` 表示在未連接 BLE 或模擬器時，透過 `ingest()` 進行封包測試，不能標示成真實感測。

## 4. 前端介面

```js
import {
  CollarBridge, normalizePacket, encodePacket, normalizeUuid, JsonLineDecoder
} from './device.js';

const bridge = new CollarBridge();

bridge.addEventListener('status', (event) => {
  // state、transport、deviceName、lastSeen、message
  renderConnectionStatus(event.detail);
});

bridge.addEventListener('measurement', (event) => {
  const packet = event.detail;
  // 檢查 source，保留 recordedAt；累計欄位以最新值更新，勿重複加總。
  saveMeasurement(packet);
});

bridge.addEventListener('packeterror', (event) => {
  renderPacketError(event.detail.message);
});

// 必須由點擊等使用者手勢觸發。
connectButton.addEventListener('click', async () => {
  await bridge.connectBle({
    serviceUuid: serviceUuidInput.value.trim(),
    characteristicUuid: characteristicUuidInput.value.trim()
  });
});

disconnectButton.addEventListener('click', () => bridge.disconnect());
simulateButton.addEventListener('click', () => bridge.connectSimulator());
```

`connectBle()` 會先呼叫瀏覽器裝置選擇器 `requestDevice()`，再連線 GATT、取得指定服務與特徵，最後訂閱通知。取消選擇器、拒絕授權、找不到服務、特徵不支援通知、連線失敗等情況都必須顯示實際錯誤，不能切換成假成功。`disconnect()` 會停止模擬器計時器、取消通知並清除事件監聽與接收緩衝。非預期 GATT 斷線也必須回到未連線狀態；本版不在背景自動重新配對。

其他匯出介面與回傳約定：

- `normalizePacket(payload)`：驗證並整理 v1 封包；非法內容拋出錯誤。
- `encodePacket(payload)`：驗證封包，產生供傳送使用、帶結尾 LF 的 UTF-8 訊息。
- `normalizeUuid(value)`：驗證並正規化 UUID；不會替硬體推測服務值。
- `new JsonLineDecoder()`：獨立的通知分片解碼器；`push(chunk)` 回傳 `{ frames, errors }`，保留未完整訊息等待下一片。
- `bridge.ingest(payload)`：合法且序號較新的封包回傳含 `source` 的標準封包並發出 `measurement`；重複／較舊序號回傳 `null`；非法封包拋出錯誤。
- `packeterror` 事件：`detail` 為 `{ message }`，供介面提示通知解析或封包驗證失敗。

`status` getter 與 `status` 事件的形狀為：

```js
{
  state: 'disconnected', // connecting | connected | simulator | error
  transport: null,       // ble | simulator | null
  deviceName: null,
  lastSeen: null,        // 最近有效封包的接收時間
  message: '尚未連接頸圈'
}
```

模擬器必須由使用者啟動，裝置 ID 為 `SIM-WPCD-001`，每十秒提供一筆範例資料，來源固定為 `simulator`。它只用於驗證資料流、同步狀態與介面，不證明任何感測器已可運作，也不提供心率或疾病風險預測。

## 5. 瀏覽器與手機限制

Web Bluetooth 需要 HTTPS 安全上下文、瀏覽器支援及使用者手勢與授權。支援情況會受作業系統、瀏覽器版本和企業政策影響，應在目標裝置實測；單純把網站安裝成 PWA 不會新增藍牙能力。

iOS Safari／iOS PWA 目前不能藉由這個 Web Bluetooth 通道直接連接頸圈。若產品需要 iPhone 直接配對，應另行建置原生 App／原生橋接；另一方案是由受信任的閘道或原生服務接收 BLE，再透過有認證的雲端 API 同步到 PWA。這些橋接與雲端服務不包含在本版已驗證功能內，不能對使用者宣稱已支援。

BLE 連線通常不會在 PWA 關閉或背景執行時維持。連續收集應由頸圈本身保存資料，並在下次連線時依序補送；背景通知、雲端同步與多人共享需要額外服務及權限設計。

## 6. 資料與安全責任

- 不把裝置私鑰、共用密碼、雲端管理金鑰放在前端程式、localStorage 或下載的設定檔。
- 頸圈配對、bonding、連線加密及防冒用措施由硬體與產品安全設計確認。GATT 服務 UUID 與裝置名稱不是身分驗證。
- 本版裝置內儲存與匯出不等於加密雲端備份。共用手機的其他使用者可能接觸資料；正式多帳號產品需獨立設計授權、保存期限及刪除機制。
- 校時、重傳、重複序號及離線補送均須實測；不可將接收時間冒充量測時間。
- 在正式使用前加入感測品質與缺失資料處理機制。不要將缺失、拒絕或斷線資料顯示成「正常」。

## 7. 實機驗收清單

- [ ] 核對實際服務／特徵 UUID、notify／indicate 支援與韌體版本。
- [ ] 在目標 Android／桌面瀏覽器測試使用者選擇、取消、拒絕與再次連線。
- [ ] 驗證 iPhone 的原生橋接或閘道路徑；未完成前明示不支援直接 BLE。
- [ ] 測試 MTU 分片、UTF-8 拆分、單通知多封包、超長／錯誤 JSON 及未知欄位。
- [ ] 測試時鐘偏差、未來時間、UTC 跨日、裝置重啟、重複／亂序序號與離線補送。
- [ ] 測試關閉分頁、手機鎖定、超出距離、關閉藍牙及電量耗盡的狀態顯示。
- [ ] 確認真實資料與模擬資料分開標示、保存與匯出。
- [ ] 對照影片人工標註驗證活動／休息／搔抓；檢查不同體型、毛長與配戴情況。
- [ ] 針對體表溫度與心率另行設計對照量測及品質門檻，不把概念分數當成醫療準確率。
- [ ] 完成裝置認證、權限、保存與刪除測試，再決定正式上市宣稱與需要的法規評估。

目前交付的是可開始韌體串接的前端契約與實作。完成上述驗收後，才可對特定硬體型號宣稱連線及量測支援；疾病診斷與臨床風險預測不在本版能力範圍。
