jest.mock('axios');
const axios = require('axios');
const { frankfurter, erapi } = require('./providers');

describe('fx/providers', () => {
  beforeEach(() => jest.clearAllMocks());

  test('frankfurter returns the rate and the date the provider actually priced', async () => {
    axios.get.mockResolvedValue({ data: { amount: 1, base: 'INR', date: '2026-09-04', rates: { SGD: 0.01341 } } });
    const r = await frankfurter('INR', 'SGD', '2026-09-06');
    expect(r).toEqual({ rate: 0.01341, providerDate: '2026-09-04', source: 'frankfurter' });
    expect(axios.get.mock.calls[0][0]).toBe('https://api.frankfurter.dev/v1/2026-09-06?base=INR&symbols=SGD');
    expect(axios.get.mock.calls[0][1].timeout).toBe(5000);
  });

  test('frankfurter asks for latest when no date is given, and returns null on a provider error', async () => {
    axios.get.mockResolvedValueOnce({ data: { date: '2026-09-16', rates: { SGD: 0.01327 } } });
    expect((await frankfurter('INR', 'SGD')).providerDate).toBe('2026-09-16');
    expect(axios.get.mock.calls[0][0]).toBe('https://api.frankfurter.dev/v1/latest?base=INR&symbols=SGD');
    axios.get.mockRejectedValueOnce(Object.assign(new Error('not found'), { response: { status: 404 } }));
    expect(await frankfurter('VND', 'SGD', '2026-09-04')).toBeNull();
    axios.get.mockResolvedValueOnce({ data: { date: '2026-09-16', rates: {} } });
    expect(await frankfurter('INR', 'VND')).toBeNull();
  });

  // Small rates carry almost no precision in the direction a receipt needs, so
  // both providers are asked the other way round and the answer inverted.
  test('a thin rate is fetched the other way round and inverted', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { date: '2026-09-18', rates: { SGD: 0.000072 } } })   // IDR → SGD, two figures
      .mockResolvedValueOnce({ data: { date: '2026-09-18', rates: { IDR: 13941.2 } } });   // SGD → IDR, six
    const r = await frankfurter('IDR', 'SGD', '2026-09-18');
    expect(r.source).toBe('frankfurter');
    expect(r.providerDate).toBe('2026-09-18');
    expect(r.rate).toBeCloseTo(1 / 13941.2, 12);
    expect(r.rate).not.toBe(0.000072);
    expect(axios.get.mock.calls[1][0]).toBe('https://api.frankfurter.dev/v1/2026-09-18?base=SGD&symbols=IDR');
    // 10,000,000 IDR: the thin rate says 720.00, the inverted one 717.29
    expect(Math.round(10000000 * r.rate * 100) / 100).toBeCloseTo(717.3, 1);
  });

  test('a healthy rate is taken as it comes, with one request', async () => {
    axios.get.mockResolvedValueOnce({ data: { date: '2026-09-18', rates: { SGD: 1.2784 } } });
    expect((await frankfurter('USD', 'SGD', '2026-09-18')).rate).toBe(1.2784);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('a thin rate with no way back keeps what it had', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { date: '2026-09-18', rates: { SGD: 0.000072 } } })
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { response: { status: 404 } }));
    expect((await frankfurter('IDR', 'SGD', '2026-09-18')).rate).toBe(0.000072);
  });

  test('erapi inverts a thin rate too', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { result: 'success', time_last_update_utc: 'Fri, 18 Sep 2026 00:02:31 +0000', rates: { SGD: 0.000049 } } })
      .mockResolvedValueOnce({ data: { result: 'success', time_last_update_utc: 'Fri, 18 Sep 2026 00:02:31 +0000', rates: { VND: 20375.168328 } } });
    const r = await erapi('VND', 'SGD');
    expect(r.rate).toBeCloseTo(1 / 20375.168328, 12);
    expect(r.source).toBe('open.er-api');
    expect(axios.get.mock.calls[1][0]).toBe('https://open.er-api.com/v6/latest/SGD');
  });

  test('erapi returns the latest rate and its update date; a failed result is null', async () => {
    axios.get.mockResolvedValueOnce({ data: { result: 'success', time_last_update_utc: 'Thu, 17 Sep 2026 00:02:31 +0000', rates: { SGD: 0.013291 } } });
    expect(await erapi('INR', 'SGD')).toEqual({ rate: 0.013291, providerDate: '2026-09-17', source: 'open.er-api' });
    axios.get.mockResolvedValueOnce({ data: { result: 'error', 'error-type': 'unsupported-code' } });
    expect(await erapi('XXX', 'SGD')).toBeNull();
  });
});
