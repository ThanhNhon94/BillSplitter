import type { BillSpec, Category, PaymentTarget } from '@/domain';
import type { Action } from '@/domain';
import type { AppSnapshot } from './AppSnapshot';
import type { UserRecord } from './records';

/** Lỗi nghiệp vụ có thông điệp tiếng Việt, hiện thẳng cho người dùng. */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/** Hoá đơn người dùng muốn lưu. id = null nghĩa là tạo mới. */
export interface BillInput {
  id: string | null;
  groupId: string;
  title: string;
  spec: BillSpec;
  category: Category;
  /** Ngày chi (epoch ms). 0 = hôm nay. */
  date: number;
}

export type Unsubscribe = () => void;

/**
 * Cổng dữ liệu duy nhất của UI. Hiện thực duy nhất là FirebaseLedgerRepository (Firestore).
 * Quyền và quy tắc tiền kiểm ở đây, và lặp lại trong firestore.rules; UI không tự kiểm.
 * Lỗi nghiệp vụ ném LedgerError; lỗi mạng ném nguyên lỗi của Firebase.
 */
export interface LedgerRepository {
  /** Toàn bộ dữ liệu của người dùng hiện tại, phát lại mỗi khi có thay đổi (kể cả thay đổi chưa lên server). */
  subscribe(
    userId: string,
    onSnapshot: (s: AppSnapshot) => void,
    onError?: (e: Error) => void,
  ): Unsubscribe;

  /**
   * Ngắt rồi nối lại kết nối tới server ngay, bỏ qua khoảng chờ tăng dần của SDK (có thể tới cả phút sau vài
   * lần thất bại, vd khi app vừa trở lại từ nền mà mạng chưa sẵn sàng). Listener đang mở vẫn giữ nguyên.
   */
  reconnect(): Promise<void>;

  /**
   * Tìm tài khoản theo đúng số điện thoại (chuẩn hoá trước khi so). Không tìm gần đúng, không liệt kê,
   * để không ai dò được danh bạ người dùng. Không thấy → null. Số sai định dạng → LedgerError.
   */
  findUserByPhone(rawPhone: string): Promise<UserRecord | null>;

  /** Thêm một tài khoản vào nhóm. Chỉ thành viên nhóm được thêm người; người được thêm nhận thông báo. */
  addMember(groupId: string, userId: string, actorId: string): Promise<void>;

  /** Vào nhóm bằng mã mời (FR3). Trả id nhóm. */
  joinByInviteCode(rawCode: string, userId: string): Promise<string>;

  /** Người tạo nhóm xoá một thành viên (FR4). Không xoá được khi người đó còn khoản chưa xong trong nhóm. */
  removeMember(groupId: string, userId: string, actorId: string): Promise<void>;

  /** Rời nhóm (FR14). Không rời được khi còn nợ hoặc còn được nợ trong nhóm. */
  leaveGroup(groupId: string, userId: string): Promise<void>;

  /**
   * Xoá nhóm cùng toàn bộ hoá đơn và khoản nợ. Chỉ người tạo nhóm được xoá, và chỉ khi mọi
   * khoản trong nhóm đã xác nhận xong. Các thành viên còn lại nhận thông báo.
   */
  deleteGroup(groupId: string, actorId: string): Promise<void>;

  /** Đổi tên hiển thị (FR13). */
  renameUser(userId: string, name: string): Promise<void>;

  setPaymentTarget(userId: string, target: PaymentTarget): Promise<void>;

  clearPaymentTarget(userId: string): Promise<void>;

  /** Trả id nhóm mới. Người tạo luôn đứng đầu danh sách thành viên. */
  createGroup(
    name: string,
    creatorId: string,
    memberIds: readonly string[],
    guestNames: readonly string[],
  ): Promise<string>;

  /** Lưu hoá đơn (mới hoặc sửa). Chỉ người tạo hoặc người trả được sửa. Trả id. */
  saveBill(input: BillInput, actorId: string): Promise<string>;

  deleteBill(billId: string, actorId: string): Promise<void>;

  /** Áp dụng một bước của máy trạng thái thanh toán; kiểm quyền theo vai trò của actor. */
  applyDebtAction(debtKey: string, action: Action, actorId: string): Promise<void>;

  /** Gửi nhắc (không đổi trạng thái). */
  sendReminder(
    recipientId: string,
    fromId: string,
    message: string,
    billId: string | null,
    debtKey: string | null,
  ): Promise<void>;
}
