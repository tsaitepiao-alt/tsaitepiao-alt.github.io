/**
 * WPCD collar transport contract v1.
 * No transport connects without an explicit caller action. All measurements
 * retain their origin; simulator data can never be mistaken for BLE data.
 */
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 16 * 1024;

const METRIC_RANGES = Object.freeze({
  activityMinutes: [0, 1440],
  restMinutes: [0, 1440],
  scratchCount: [0, 100000],
  surfaceTemperatureC: [15, 50],
  heartRateBpm: [30, 350],
  batteryPercent: [0, 100],
});
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (message) => new TypeError(message);

function parseTimestamp(value, now) {
  if (typeof value !== 'string') throw error('recordedAt 必須為含時區的 ISO 8601 字串。');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw error('recordedAt 必須包含日期、秒與 Z 或時區偏移。');
  const [, year, month, day, hour, minute, second, , zone, offsetHour, offsetMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 ||
      Number(minute) > 59 || Number(second) > 59 ||
      (zone !== 'Z' && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))) {
    throw error('recordedAt 包含無效的日期或時間。');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw error('recordedAt 無法解析。');
  if (milliseconds > now + 5 * 60 * 1000) throw error('裝置時間超前超過 5 分鐘，請先校時。');
  return new Date(milliseconds).toISOString();
}

/** Validate a packet and return a fresh canonical object. Never coerce numbers. */
export function normalizePacket(payload, { now = Date.now() } = {}) {
  let input = payload;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_FRAME_BYTES) throw error('資料封包超過 16 KB。');
    try { input = JSON.parse(input); } catch { throw error('資料不是有效的 JSON。'); }
  }
  if (!isRecord(input)) throw error('資料封包必須為物件。');
  if (input.schemaVersion !== PROTOCOL_VERSION) throw error('不支援的 schemaVersion，必須為 1。');
  if (typeof input.deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(input.deviceId)) {
    throw error('deviceId 必須為 1–64 字元的裝置識別碼。');
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw error('sequence 必須為非負安全整數。');
  }
  const recordedAt = parseTimestamp(input.recordedAt, now);
  if (!isRecord(input.metrics)) throw error('metrics 必須為物件。');
  const keys = Object.keys(input.metrics);
  if (!keys.length) throw error('metrics 至少需要一項量測。');
  const metrics = {};
  for (const key of keys) {
    if (!hasOwn(METRIC_RANGES, key)) throw error(`不支援的量測欄位：${key}`);
    const value = input.metrics[key];
    const [minimum, maximum] = METRIC_RANGES[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw error(`${key} 必須是 ${minimum}–${maximum} 範圍內的有限數值。`);
    }
    if (key === 'scratchCount' && !Number.isSafeInteger(value)) throw error('scratchCount 必須為整數。');
    metrics[key] = value;
  }
  if (hasOwn(metrics, 'activityMinutes') && hasOwn(metrics, 'restMinutes') &&
      metrics.activityMinutes + metrics.restMinutes > 1440) {
    throw error('同日活動與休息累計合計不能超過 1440 分鐘。');
  }
  return {
    schemaVersion: PROTOCOL_VERSION,
    deviceId: input.deviceId,
    sequence: input.sequence,
    recordedAt,
    metrics,
  };
}

/** Encode one newline-delimited UTF-8 frame. Split these bytes to match the BLE MTU. */
export function encodePacket(payload) {
  return new TextEncoder().encode(`${JSON.stringify(normalizePacket(payload))}\n`);
}

/** Byte-oriented framing preserves UTF-8 characters split across notifications. */
export class JsonLineDecoder {
  constructor({ maxBytes = MAX_FRAME_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FRAME_BYTES) throw error('無效的框架長度上限。');
    this.maxBytes = maxBytes;
    this.buffer = [];
    this.discarding = false;
  }
  reset() { this.buffer = []; this.discarding = false; }
  push(chunk) {
    let bytes;
    if (chunk instanceof ArrayBuffer) bytes = new Uint8Array(chunk);
    else if (ArrayBuffer.isView(chunk)) bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    else throw error('通知內容必須為 ArrayBuffer 或 typed array。');
    const frames = [], errors = [];
    for (const byte of bytes) {
      if (byte === 10) {
        if (!this.discarding && this.buffer.length) {
          const frameBytes = Uint8Array.from(this.buffer);
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(frameBytes).trim();
            if (text) frames.push(text);
          } catch { errors.push('封包含有無效的 UTF-8 編碼。'); }
        }
        this.buffer = [];
        this.discarding = false;
      } else if (!this.discarding) {
        if (this.buffer.length >= this.maxBytes) {
          this.buffer = [];
          this.discarding = true;
          errors.push('通知封包超過 16 KB，已丟棄至下一個換行。');
        } else this.buffer.push(byte);
      }
    }
    return { frames, errors };
  }
}

export function normalizeUuid(value) {
  if (typeof value !== 'string') throw error('請填入硬體提供的服務與通知特徵 UUID。');
  const uuid = value.trim().toLowerCase();
  if (/^[0-9a-f]{4}$/.test(uuid)) return `0000${uuid}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}$/.test(uuid)) return `${uuid}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) return uuid;
  throw error('UUID 格式錯誤，請使用硬體提供的 16、32 或 128 位元 UUID。');
}

export class CollarBridge extends EventTarget {
  constructor(config = {}) {
    super();
    this.config = { ...config };
    this._status = { state: 'disconnected', transport: null, deviceName: null, lastSeen: null, message: '尚未連接頸圈' };
    this._sequences = new Map();
    this._decoder = new JsonLineDecoder();
    this._session = 0;
    this._simSequence = 0;
    this._timer = null;
    this._device = null;
    this._characteristic = null;
    this._onNotification = null;
    this._onDisconnect = null;
  }

  get status() { return { ...this._status }; }

  _setStatus(update) {
    this._status = { ...this._status, ...update };
    this.dispatchEvent(new CustomEvent('status', { detail: this.status }));
  }

  _packetError(message) {
    this.dispatchEvent(new CustomEvent('packeterror', { detail: { message } }));
  }

  /** Returns null for duplicate/stale sequence; invalid input throws and emits packeterror. */
  ingest(payload) {
    let packet;
    try { packet = normalizePacket(payload); }
    catch (cause) { this._packetError(cause.message); throw cause; }
    const previous = this._sequences.get(packet.deviceId);
    if (previous !== undefined && packet.sequence <= previous) return null;
    this._sequences.delete(packet.deviceId);
    this._sequences.set(packet.deviceId, packet.sequence);
    if (this._sequences.size > 128) this._sequences.delete(this._sequences.keys().next().value);
    const source = this._status.transport === 'ble' ? 'ble' : this._status.transport === 'simulator' ? 'simulator' : 'manual';
    const measurement = { ...packet, source };
    this._setStatus({ lastSeen: new Date().toISOString() });
    this.dispatchEvent(new CustomEvent('measurement', { detail: measurement }));
    return measurement;
  }

  _receiveNotification(event) {
    const { frames, errors } = this._decoder.push(event.target.value);
    for (const message of errors) this._packetError(message);
    for (const frame of frames) {
      try { this.ingest(frame); } catch { /* One malformed frame must not block the next. */ }
    }
  }

  /** Call from a user gesture in an HTTPS browser with Web Bluetooth support. */
  async connectBle({ serviceUuid = this.config.serviceUuid, characteristicUuid = this.config.characteristicUuid } = {}) {
    const service = normalizeUuid(serviceUuid);
    const characteristic = normalizeUuid(characteristicUuid);
    if (!globalThis.isSecureContext) throw error('藍牙連線需要 HTTPS 安全環境。');
    if (!globalThis.navigator?.bluetooth?.requestDevice) {
      throw error('此瀏覽器不支援 Web Bluetooth；iOS Safari／PWA 需要原生橋接或雲端閘道。');
    }
    this.disconnect();
    const session = ++this._session;
    this._setStatus({ state: 'connecting', transport: 'ble', deviceName: null, lastSeen: null, message: '請在瀏覽器選擇頸圈' });
    let device = null;
    try {
      device = await globalThis.navigator.bluetooth.requestDevice({
        filters: [{ services: [service] }],
        optionalServices: [service],
      });
      if (session !== this._session) throw new DOMException('連線已取消。', 'AbortError');
      this._device = device;
      this._onDisconnect = () => {
        if (session !== this._session) return;
        this.disconnect();
        this._setStatus({ message: '頸圈已斷線，請靠近裝置後重新連接' });
      };
      device.addEventListener('gattserverdisconnected', this._onDisconnect);
      if (!device.gatt) throw error('此裝置未提供 GATT 服務。');
      const server = await device.gatt.connect();
      if (session !== this._session) throw new DOMException('連線已取消。', 'AbortError');
      const primary = await server.getPrimaryService(service);
      if (session !== this._session) throw new DOMException('連線已取消。', 'AbortError');
      const notify = await primary.getCharacteristic(characteristic);
      if (session !== this._session) throw new DOMException('連線已取消。', 'AbortError');
      if (!notify.properties.notify && !notify.properties.indicate) throw error('指定特徵不支援 notify／indicate。');
      this._characteristic = notify;
      this._onNotification = (event) => {
        if (session === this._session) this._receiveNotification(event);
      };
      notify.addEventListener('characteristicvaluechanged', this._onNotification);
      await notify.startNotifications();
      if (session !== this._session) throw new DOMException('連線已取消。', 'AbortError');
      this.config = { ...this.config, serviceUuid: service, characteristicUuid: characteristic };
      this._setStatus({ state: 'connected', transport: 'ble', deviceName: device.name || device.id || 'BLE 頸圈', message: '已連接，等待頸圈資料' });
      return this.status;
    } catch (cause) {
      if (session !== this._session) {
        if (device?.gatt?.connected) device.gatt.disconnect();
        throw cause;
      }
      this.disconnect();
      const cancelled = cause?.name === 'NotFoundError' || cause?.name === 'AbortError';
      this._setStatus({ state: cancelled ? 'disconnected' : 'error', transport: null,
        message: cancelled ? '已取消藍牙連線' : `頸圈連線失敗：${cause?.message || '請檢查裝置與 UUID'}` });
      throw cause;
    }
  }

  /** Explicit simulator. Daily totals use the UTC date of recordedAt. */
  connectSimulator() {
    this.disconnect();
    this._setStatus({ state: 'simulator', transport: 'simulator', deviceName: 'WPCD 頸圈模擬器', lastSeen: null, message: '模擬資料串流，每 10 秒更新' });
    const send = () => {
      const now = new Date();
      const elapsed = now.getUTCHours() * 60 + now.getUTCMinutes();
      this.ingest({
        schemaVersion: PROTOCOL_VERSION,
        deviceId: 'SIM-WPCD-001',
        // A timestamp cursor survives normal page reloads without coupling the
        // transport to storage. Multiple packets in one millisecond still rise.
        sequence: (this._simSequence = Math.max(this._simSequence + 1, Date.now())),
        recordedAt: now.toISOString(),
        metrics: {
          activityMinutes: Math.floor(elapsed * 0.09),
          restMinutes: Math.floor(elapsed * 0.61),
          scratchCount: Math.floor(elapsed / 56),
          surfaceTemperatureC: Math.round((33.7 + Math.random() * 0.5) * 10) / 10,
          batteryPercent: 86,
        },
      });
    };
    send();
    this._timer = globalThis.setInterval(send, 10000);
    return this.status;
  }

  disconnect() {
    ++this._session;
    if (this._timer !== null) globalThis.clearInterval(this._timer);
    this._timer = null;
    if (this._characteristic && this._onNotification) {
      this._characteristic.removeEventListener('characteristicvaluechanged', this._onNotification);
      try { this._characteristic.stopNotifications()?.catch(() => {}); } catch { /* Device may already be disconnected. */ }
    }
    if (this._device && this._onDisconnect) this._device.removeEventListener('gattserverdisconnected', this._onDisconnect);
    try { if (this._device?.gatt?.connected) this._device.gatt.disconnect(); } catch { /* Best-effort GATT cleanup. */ }
    this._device = null;
    this._characteristic = null;
    this._onNotification = null;
    this._onDisconnect = null;
    this._decoder.reset();
    this._setStatus({ state: 'disconnected', transport: null, deviceName: null, message: '尚未連接頸圈' });
    return this.status;
  }
}
