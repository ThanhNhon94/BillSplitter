/**
 * Quy tắc đồng bộ dữ liệu cho AppContext, tách ra để kiểm thử được.
 *
 * Một listener onSnapshot gặp lỗi thì dừng hẳn, không tự nối lại. Nên khi có lỗi, AppContext huỷ cả
 * watchSnapshot và đăng ký lại sau một khoảng chờ tăng dần.
 */

/** Chờ bao lâu trước khi tải lại xong mà vẫn chưa có dữ liệu thì báo mạng chậm. */
export const SLOW_AFTER_MS = 12_000;

/** Ở nền lâu hơn chừng này thì khi quay lại app sẽ nối lại kết nối Firestore. */
export const RECONNECT_AFTER_BACKGROUND_MS = 30_000;

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

/** Khoảng chờ trước lần thử lại thứ `failures` (tính từ 1): 2s, 4s, 8s, 16s, rồi 30s mãi. */
export function retryDelay(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (n - 1));
}

/** Câu báo lỗi đồng bộ cho người dùng, theo mã lỗi Firestore. */
export function syncErrorMessage(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  switch (code) {
    case 'unavailable':
    case 'deadline-exceeded':
      return 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.';
    case 'unauthenticated':
      return 'Phiên đăng nhập đã hết hạn. Đang thử kết nối lại…';
    case 'permission-denied':
      return 'Không có quyền đọc dữ liệu. Thử đăng xuất rồi đăng nhập lại.';
    case 'resource-exhausted':
      return 'Máy chủ đang quá tải. Thử lại sau ít phút.';
    default:
      return 'Không đồng bộ được dữ liệu. Đang thử lại…';
  }
}
