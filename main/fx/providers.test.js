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

  test('erapi returns the latest rate and its update date; a failed result is null', async () => {
    axios.get.mockResolvedValueOnce({ data: { result: 'success', time_last_update_utc: 'Thu, 17 Sep 2026 00:02:31 +0000', rates: { SGD: 0.013291 } } });
    expect(await erapi('INR', 'SGD')).toEqual({ rate: 0.013291, providerDate: '2026-09-17', source: 'open.er-api' });
    axios.get.mockResolvedValueOnce({ data: { result: 'error', 'error-type': 'unsupported-code' } });
    expect(await erapi('XXX', 'SGD')).toBeNull();
  });
});
