'use strict';

const fc = require('fast-check');

// 從 handler 模組取出可測試的函式
const handler = require('../parking-availability');
const {
  transformAvailability,
  isCacheValid,
  _CACHE_TTL_MS
} = handler;

// ─────────────────────────────────────────────
// Property 5: 資料轉換保留所有停車場記錄
// Feature: vercel-proxy-parking-availability, Property 5: 資料轉換保留所有停車場記錄
// ─────────────────────────────────────────────
describe('transformAvailability', () => {
  test('Property 5: 輸出物件包含所有輸入記錄的 key，且數值正確對應', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ParkingLotID:      fc.string({ minLength: 1, maxLength: 30 }),
            SmallCarVacancy:   fc.oneof(fc.integer({ min: -1, max: 500 }), fc.constant(null)),
            LargeCarVacancy:   fc.oneof(fc.integer({ min: -1, max: 200 }), fc.constant(null)),
            MotorcycleVacancy: fc.oneof(fc.integer({ min: -1, max: 1000 }), fc.constant(null))
          }),
          { maxLength: 50 }
        ),
        (tdxArray) => {
          const result = transformAvailability(tdxArray);
          return tdxArray.every(item => {
            const entry = result[item.ParkingLotID];
            if (!entry) return false;
            // null → -1
            const expectedSmall = item.SmallCarVacancy   != null ? item.SmallCarVacancy   : -1;
            const expectedLarge = item.LargeCarVacancy   != null ? item.LargeCarVacancy   : -1;
            const expectedMoto  = item.MotorcycleVacancy != null ? item.MotorcycleVacancy : -1;
            return (
              entry.smallCar   === expectedSmall &&
              entry.largeCar   === expectedLarge &&
              entry.motorcycle === expectedMoto
            );
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  test('空陣列回傳空物件', () => {
    expect(transformAvailability([])).toEqual({});
  });

  test('undefined 欄位轉換為 -1', () => {
    const input = [{ ParkingLotID: 'LOT-001', SmallCarVacancy: undefined, LargeCarVacancy: null, MotorcycleVacancy: 5 }];
    const result = transformAvailability(input);
    expect(result['LOT-001']).toEqual({ smallCar: -1, largeCar: -1, motorcycle: 5 });
  });
});

// ─────────────────────────────────────────────
// Property 1 & 2: Cache hit/miss 判斷
// Feature: vercel-proxy-parking-availability, Property 1: Cache hit 不呼叫 TDX API
// Feature: vercel-proxy-parking-availability, Property 2: Cache miss 或過期時呼叫 TDX API 並更新 Cache
// ─────────────────────────────────────────────
describe('isCacheValid', () => {
  test('Property 1: age < TTL 時回傳 true（cache hit）', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: _CACHE_TTL_MS - 1 }),
        (ageMs) => {
          const entry = {
            data:     { 'LOT-001': { smallCar: 5, largeCar: 0, motorcycle: 10 } },
            cachedAt: Date.now() - ageMs
          };
          return isCacheValid(entry) === true;
        }
      ),
      { numRuns: 100 }
    );
  });

  test('Property 2: age >= TTL 時回傳 false（cache miss）', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: _CACHE_TTL_MS, max: _CACHE_TTL_MS * 10 }),
        (ageMs) => {
          const entry = {
            data:     { 'LOT-001': { smallCar: 5, largeCar: 0, motorcycle: 10 } },
            cachedAt: Date.now() - ageMs
          };
          return isCacheValid(entry) === false;
        }
      ),
      { numRuns: 100 }
    );
  });

  test('data 為 null 時回傳 false', () => {
    expect(isCacheValid({ data: null, cachedAt: Date.now() })).toBe(false);
  });

  test('cachedAt 為 null 時回傳 false', () => {
    expect(isCacheValid({ data: {}, cachedAt: null })).toBe(false);
  });

  test('entry 為 null 時回傳 false', () => {
    expect(isCacheValid(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Property 4: 無效城市代碼回傳 400
// Feature: vercel-proxy-parking-availability, Property 4: 無效城市代碼回傳 400
// ─────────────────────────────────────────────
describe('handler — city 參數驗證', () => {
  function makeReqRes(city) {
    const req = { method: 'GET', query: city !== undefined ? { city } : {} };
    const statusCode = { value: null };
    const body = { value: null };
    const res = {
      setHeader: () => {},
      status: (code) => { statusCode.value = code; return res; },
      json:   (data) => { body.value = data; return res; },
      end:    ()     => res
    };
    return { req, res, statusCode, body };
  }

  test('Property 4: 任意非法城市字串回傳 400 且含 error 欄位', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 20 }).filter(
          s => !['Kaohsiung', 'Tainan', 'Chiayi'].includes(s)
        ),
        async (invalidCity) => {
          // 設定假環境變數以通過憑證檢查
          process.env.TDX_CLIENT_ID     = 'test-id';
          process.env.TDX_CLIENT_SECRET = 'test-secret';
          const { req, res, statusCode, body } = makeReqRes(invalidCity);
          await handler(req, res);
          return statusCode.value === 400 && typeof body.value.error === 'string' && body.value.error.length > 0;
        }
      ),
      { numRuns: 50 }
    );
  });

  test('city 參數缺失時回傳 400', async () => {
    process.env.TDX_CLIENT_ID     = 'test-id';
    process.env.TDX_CLIENT_SECRET = 'test-secret';
    const { req, res, statusCode, body } = makeReqRes(undefined);
    await handler(req, res);
    expect(statusCode.value).toBe(400);
    expect(typeof body.value.error).toBe('string');
  });
});

// ─────────────────────────────────────────────
// Property 7: 環境變數缺失時回傳 500 且含 error 欄位
// Feature: vercel-proxy-parking-availability, Property 7: 錯誤回應一律包含 error 欄位
// ─────────────────────────────────────────────
describe('handler — 環境變數缺失', () => {
  test('TDX_CLIENT_ID 缺失時回傳 500 且含 error 欄位', async () => {
    const savedId     = process.env.TDX_CLIENT_ID;
    const savedSecret = process.env.TDX_CLIENT_SECRET;
    delete process.env.TDX_CLIENT_ID;
    delete process.env.TDX_CLIENT_SECRET;

    const statusCode = { value: null };
    const body = { value: null };
    const req = { method: 'GET', query: { city: 'Kaohsiung' } };
    const res = {
      setHeader: () => {},
      status: (code) => { statusCode.value = code; return res; },
      json:   (data) => { body.value = data; return res; },
      end:    ()     => res
    };

    await handler(req, res);
    expect(statusCode.value).toBe(500);
    expect(typeof body.value.error).toBe('string');
    expect(body.value.error.length).toBeGreaterThan(0);

    // 還原環境變數
    if (savedId)     process.env.TDX_CLIENT_ID     = savedId;
    if (savedSecret) process.env.TDX_CLIENT_SECRET = savedSecret;
  });
});

// ─────────────────────────────────────────────
// Property 6: Availability_Data JSON 序列化 round-trip
// Feature: vercel-proxy-parking-availability, Property 6: Availability_Data JSON 序列化 round-trip
// ─────────────────────────────────────────────
describe('Availability_Data JSON round-trip', () => {
  test('Property 6: JSON.parse(JSON.stringify(data)) 與原始物件深度相等', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.record({
            smallCar:   fc.integer({ min: -1, max: 500 }),
            largeCar:   fc.integer({ min: -1, max: 200 }),
            motorcycle: fc.integer({ min: -1, max: 1000 })
          })
        ),
        (availData) => {
          const roundTripped = JSON.parse(JSON.stringify(availData));
          return JSON.stringify(roundTripped) === JSON.stringify(availData);
        }
      ),
      { numRuns: 100 }
    );
  });
});
