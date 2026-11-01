import { retryDelay, syncErrorMessage } from '../sync';

describe('sync', () => {
  it('thử lại với khoảng chờ tăng gấp đôi, tối đa 30 giây', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(retryDelay)).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(retryDelay(0)).toBe(2000);
  });

  it('báo lỗi theo mã Firestore, có câu mặc định', () => {
    expect(syncErrorMessage({ code: 'unavailable' })).toMatch(/mạng/);
    expect(syncErrorMessage({ code: 'permission-denied' })).toMatch(/quyền/);
    expect(syncErrorMessage(new Error('x'))).toMatch(/Không đồng bộ được/);
    expect(syncErrorMessage(undefined)).toMatch(/Không đồng bộ được/);
  });
});
