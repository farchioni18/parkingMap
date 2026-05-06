/**
 * Vercel Serverless Function — Parking Availability Proxy
 *
 * 作為 GitHub Pages 前端與 TDX 交通資料平台之間的安全代理層。
 * - TDX 憑證存放於 Vercel 環境變數，永不暴露於前端
 * - in-memory cache（30 分鐘 TTL）控制 TDX API 呼叫頻率
 */

'use strict';

const CACHE_TTL_MS = 30 * 60 * 1000; // 1,800,000 ms

const VALID_CITIES = new Set(['Kaohsiung', 'Tainan', 'Chiayi']);

const TDX_TOKEN_URL =
  'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';

const TDX_AVAILABILITY_URL =
  'https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/';

/**
 * Module-level cache — 每個城市獨立快取。
 * Vercel Serverless Function 的 module-level 變數在同一 instance 的多次呼叫間會被保留。
 * @type {{ [city: string]: { data: object|null, cachedAt: number|null } }}
 */
const cache = {
  Kaohsiung: { data: null, cachedAt: null },
  Tainan:    { data: null, cachedAt: null },
  Chiayi:    { data: null, cachedAt: null }
};

/**
 * 判斷 cache entry 是否仍在 TTL 內。
 * @param {{ data: object|null, cachedAt: number|null }} entry
 * @returns {boolean}
 */
function isCacheValid(entry) {
  if (!entry || entry.data === null || entry.cachedAt === null) return false;
  return (Date.now() - entry.cachedAt) < CACHE_TTL_MS;
}

/**
 * 將 TDX API 回傳的停車場空位陣列轉換為以 ParkingLotID 為 key 的物件。
 * null / undefined 欄位統一轉為 -1。
 *
 * @param {Array<{ParkingLotID: string, SmallCarVacancy: number|null, LargeCarVacancy: number|null, MotorcycleVacancy: number|null}>} tdxArray
 * @returns {{ [id: string]: { smallCar: number, largeCar: number, motorcycle: number } }}
 */
function transformAvailability(tdxArray) {
  const result = {};
  for (const item of tdxArray) {
    result[item.ParkingLotID] = {
      smallCar:   item.SmallCarVacancy   != null ? item.SmallCarVacancy   : -1,
      largeCar:   item.LargeCarVacancy   != null ? item.LargeCarVacancy   : -1,
      motorcycle: item.MotorcycleVacancy != null ? item.MotorcycleVacancy : -1
    };
  }
  return result;
}

/**
 * 向 TDX OAuth 端點取得 access_token。
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {Promise<string>} access_token
 * @throws {Error} 若 OAuth 呼叫失敗
 */
async function getTdxToken(clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret
  });

  const res = await fetch(TDX_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString()
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TDX OAuth failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  if (!json.access_token) {
    throw new Error('TDX OAuth response missing access_token');
  }
  return json.access_token;
}

/**
 * 呼叫 TDX ParkingAvailability API 取得指定城市的即時空位資料。
 * @param {string} city  城市代碼（Kaohsiung / Tainan / Chiayi）
 * @param {string} accessToken
 * @returns {Promise<Array>} TDX 回傳的停車場空位陣列
 * @throws {Error} 若 API 呼叫失敗
 */
async function fetchTdxAvailability(city, accessToken) {
  const url = TDX_AVAILABILITY_URL + city;
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TDX API failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * 設定所有回應共用的 HTTP headers。
 * @param {import('@vercel/node').VercelResponse} res
 */
function setCommonHeaders(res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=1800');
}

/**
 * Vercel Serverless Function handler。
 * GET /api/parking-availability?city={Kaohsiung|Tainan|Chiayi}
 */
module.exports = async function handler(req, res) {
  setCommonHeaders(res);

  // 處理 CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  // 1. 環境變數檢查
  const clientId     = process.env.TDX_CLIENT_ID;
  const clientSecret = process.env.TDX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({
      error: 'Server configuration error: missing TDX credentials'
    });
  }

  // 2. city 參數驗證
  const city = req.query && req.query.city;
  if (!city || !VALID_CITIES.has(city)) {
    return res.status(400).json({
      error: 'Invalid or missing city parameter. Supported: Kaohsiung, Tainan, Chiayi'
    });
  }

  // 3. Cache hit — 直接回傳
  const entry = cache[city];
  if (isCacheValid(entry)) {
    return res.status(200).json({
      data:     entry.data,
      cachedAt: new Date(entry.cachedAt).toISOString(),
      city:     city
    });
  }

  // 4. Cache miss — 呼叫 TDX API
  try {
    const accessToken = await getTdxToken(clientId, clientSecret);
    const tdxRaw      = await fetchTdxAvailability(city, accessToken);
    // TDX 回應可能是陣列，或包在物件的某個欄位裡
    const tdxArray = Array.isArray(tdxRaw)
      ? tdxRaw
      : (tdxRaw.ParkingAvailabilities || tdxRaw.data || tdxRaw.Data || []);
    const data        = transformAvailability(tdxArray);
    const now         = Date.now();

    // 更新 cache
    cache[city].data     = data;
    cache[city].cachedAt = now;

    return res.status(200).json({
      data:     data,
      cachedAt: new Date(now).toISOString(),
      city:     city
    });
  } catch (err) {
    return res.status(502).json({
      error: 'TDX API error: ' + (err.message || String(err))
    });
  }
};

// 匯出內部函式供測試使用
module.exports.transformAvailability = transformAvailability;
module.exports.isCacheValid          = isCacheValid;
module.exports.getTdxToken           = getTdxToken;
module.exports.fetchTdxAvailability  = fetchTdxAvailability;
module.exports._cache                = cache;
module.exports._CACHE_TTL_MS         = CACHE_TTL_MS;
