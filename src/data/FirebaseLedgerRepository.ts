import {
  type DocumentReference,
  type Firestore,
  arrayRemove,
  arrayUnion,
  collection,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocs,
  query,
  runTransaction,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  type Action,
  type IntRandom,
  InviteCode,
  Money,
  PaymentStateMachine,
  type PaymentTarget,
  PhoneNumber,
  SplitEngine,
  debtKeyOf,
  parseDebtStatus,
  splitDebtKey,
} from '@/domain';
import type { AppSnapshot } from './AppSnapshot';
import { billFrom, groupFrom, statusFrom, userFrom } from './docs';
import { type BillInput, LedgerError, type LedgerRepository, type Unsubscribe } from './LedgerRepository';
import { colorIndexFor, toBill } from './mappers';
import type { BillRecord, DebtStatusRecord, GroupRecord, UserRecord } from './records';
import { watchSnapshot } from './watchSnapshot';

function fail(message: string): never {
  throw new LedgerError(message);
}

/** Một thông báo chờ ghi vào inbox/. */
interface Notice {
  to: string;
  message: string;
  billId?: string | null;
  debtKey?: string | null;
}

const BATCH_LIMIT = 450; // Firestore tối đa 500 thao tác mỗi batch

/**
 * Hiện thực LedgerRepository trên Firestore. Cùng quy tắc nghiệp vụ và cùng thông điệp với
 * LocalLedgerRepository (Room) của bản Java; chỉ khác chỗ lưu. Mỗi thao tác ghi dùng một batch hoặc
 * transaction nên không để lại dữ liệu nửa vời.
 */
export class FirebaseLedgerRepository implements LedgerRepository {
  constructor(
    private readonly db: Firestore,
    private readonly random?: IntRandom,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------- tham chiếu và đọc

  private ref(path: string, id: string): DocumentReference {
    return doc(this.db, path, id);
  }

  private async userNow(id: string): Promise<UserRecord | null> {
    const s = await getDoc(this.ref('users', id));
    return s.exists() ? userFrom(s) : null;
  }

  private async nameOf(id: string): Promise<string> {
    return (await this.userNow(id))?.name ?? '?';
  }

  private async groupNow(id: string): Promise<GroupRecord | null> {
    try {
      const s = await getDoc(this.ref('groups', id));
      return s.exists() ? groupFrom(s) : null;
    } catch (e) {
      if (isPermissionDenied(e)) return null; // không còn là thành viên = nhóm "không còn" với người này
      throw e;
    }
  }

  private async billNow(id: string): Promise<BillRecord | null> {
    const s = await getDoc(this.ref('bills', id));
    return s.exists() ? billFrom(s) : null;
  }

  private async billsOfGroupNow(groupId: string): Promise<BillRecord[]> {
    const q = await getDocs(query(collection(this.db, 'bills'), where('groupId', '==', groupId)));
    return q.docs.map(billFrom);
  }

  private async statusesOfGroupNow(groupId: string): Promise<DebtStatusRecord[]> {
    const q = await getDocs(query(collection(this.db, 'debtStatuses'), where('groupId', '==', groupId)));
    return q.docs.map(statusFrom);
  }

  /** Phải lọc cả groupId: rules chỉ chứng minh được quyền đọc khi truy vấn ràng buộc groupId. */
  private async statusesOfBillNow(billId: string, groupId: string): Promise<DebtStatusRecord[]> {
    const q = await getDocs(
      query(collection(this.db, 'debtStatuses'), where('groupId', '==', groupId), where('billId', '==', billId)),
    );
    return q.docs.map(statusFrom);
  }

  /** Dựng thông báo gửi tới tài khoản thật. Khách không có app nên không nhận thông báo trong app. */
  private async inboxDocs(from: string, notices: readonly Notice[]) {
    const out: { ref: DocumentReference; data: Record<string, unknown> }[] = [];
    const guestCache = new Map<string, boolean>();
    for (const n of notices) {
      if (!guestCache.has(n.to)) {
        const u = await this.userNow(n.to);
        guestCache.set(n.to, u == null || u.guest);
      }
      if (guestCache.get(n.to)) continue;
      out.push({
        ref: doc(collection(this.db, 'inbox')),
        data: {
          recipientId: n.to,
          fromId: from,
          message: n.message,
          billId: n.billId ?? null,
          debtKey: n.debtKey ?? null,
          createdAt: this.now(),
        },
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- dữ liệu cho UI

  subscribe(userId: string, onSnapshot: (s: AppSnapshot) => void, onError?: (e: Error) => void): Unsubscribe {
    return watchSnapshot(this.db, userId, onSnapshot, onError);
  }

  async reconnect(): Promise<void> {
    await disableNetwork(this.db);
    await enableNetwork(this.db);
  }

  // ---------------------------------------------------------------- tài khoản

  async findUserByPhone(rawPhone: string): Promise<UserRecord | null> {
    const p = PhoneNumber.normalize(rawPhone);
    if (p == null) return fail('Số điện thoại không hợp lệ. Nhập đủ 10 số, vd 0904 444 444.');
    const idx = await getDoc(this.ref('phones', p));
    if (!idx.exists()) return null;
    const u = await this.userNow(String(idx.data().uid));
    return u && !u.guest ? u : null;
  }

  async renameUser(userId: string, name: string): Promise<void> {
    const n = (name ?? '').trim();
    if (n === '') fail('Tên không được để trống.');
    if (n.length > 40) fail('Tên tối đa 40 ký tự.');
    if ((await this.userNow(userId)) == null) fail('Tài khoản không còn.');
    const b = writeBatch(this.db);
    b.update(this.ref('users', userId), { name: n });
    await b.commit();
  }

  async setPaymentTarget(userId: string, t: PaymentTarget): Promise<void> {
    if ((await this.userNow(userId)) == null) return;
    const b = writeBatch(this.db);
    b.update(this.ref('users', userId), {
      bankBin: t.bankBin,
      accountNo: t.accountNo,
      accountName: t.accountName,
      qrUpdatedAt: this.now(),
    });
    await b.commit();
  }

  async clearPaymentTarget(userId: string): Promise<void> {
    if ((await this.userNow(userId)) == null) return;
    const b = writeBatch(this.db);
    b.update(this.ref('users', userId), { bankBin: null, accountNo: null, accountName: null, qrUpdatedAt: 0 });
    await b.commit();
  }

  // ---------------------------------------------------------------- nhóm

  async createGroup(
    name: string,
    creatorId: string,
    memberIds: readonly string[],
    guestNames: readonly string[],
  ): Promise<string> {
    const now = this.now();
    const groupName = name.trim();
    const groupRef = doc(collection(this.db, 'groups'));

    // Thứ tự: người tạo, rồi các tài khoản theo thứ tự được thêm, rồi khách. Không trùng.
    const ids = new Set<string>([creatorId, ...memberIds]);
    for (const id of memberIds) {
      const u = id === creatorId ? null : await this.userNow(id);
      if (id !== creatorId && (u == null || u.guest)) fail('Một hoặc nhiều thành viên không tồn tại.');
    }
    const guests: { id: string; name: string }[] = [];
    for (const g of guestNames) {
      if (g.trim() === '') continue;
      const id = 'guest-' + doc(collection(this.db, 'users')).id;
      guests.push({ id, name: g.trim() });
      ids.add(id);
    }

    let code = InviteCode.generate(this.random);
    while ((await getDoc(this.ref('inviteCodes', code))).exists()) code = InviteCode.generate(this.random);

    const creatorName = await this.nameOf(creatorId);
    const notices: Notice[] = [...ids]
      .filter((id) => id !== creatorId)
      .map((id) => ({ to: id, message: `${creatorName} đã thêm bạn vào nhóm “${groupName}”.` }));

    const b = writeBatch(this.db);
    for (const g of guests) {
      b.set(this.ref('users', g.id), {
        name: g.name,
        guest: true,
        phone: null,
        colorIndex: colorIndexFor(g.id),
        bankBin: null,
        accountNo: null,
        accountName: null,
        qrUpdatedAt: 0,
        createdAt: now,
        createdBy: creatorId,
      });
    }
    b.set(groupRef, {
      name: groupName,
      inviteCode: code,
      createdBy: creatorId,
      createdAt: now,
      memberOrder: [...ids],
      activeMemberIds: [...ids],
    });
    b.set(this.ref('inviteCodes', code), { groupId: groupRef.id });
    for (const d of await this.inboxDocs(creatorId, notices)) b.set(d.ref, d.data);
    await b.commit();
    return groupRef.id;
  }

  async addMember(groupId: string, userId: string, actorId: string): Promise<void> {
    const g = (await this.groupNow(groupId)) ?? fail('Nhóm không còn.');
    if (!g.activeMemberIds.includes(actorId)) fail('Bạn không ở trong nhóm này.');
    if (g.activeMemberIds.includes(userId)) fail((await this.nameOf(userId)) + ' đã ở trong nhóm.');
    if ((await this.userNow(userId)) == null) fail('Tài khoản không còn.');

    const notices = await this.inboxDocs(actorId, [
      { to: userId, message: `${await this.nameOf(actorId)} đã thêm bạn vào nhóm “${g.name}”.` },
    ]);
    const b = writeBatch(this.db);
    // arrayUnion giữ vị trí cũ của người từng rời nhóm, nên hoá đơn cũ chia ra đúng như trước.
    b.update(this.ref('groups', groupId), {
      memberOrder: arrayUnion(userId),
      activeMemberIds: arrayUnion(userId),
    });
    for (const d of notices) b.set(d.ref, d.data);
    await b.commit();
  }

  async joinByInviteCode(rawCode: string, userId: string): Promise<string> {
    const code = InviteCode.normalize(rawCode);
    if (code == null) return fail('Mã mời gồm 6 ký tự, vd DAL-AT7.');
    const idx = await getDoc(this.ref('inviteCodes', code));
    if (!idx.exists()) return fail(`Không có nhóm nào dùng mã ${InviteCode.format(code)}.`);
    const groupId = String(idx.data().groupId);
    const u = await this.userNow(userId);
    if (u == null || u.guest) return fail('Tài khoản không hợp lệ.');

    // Đã ở trong nhóm thì đọc được tài liệu nhóm; chưa thì security rules từ chối đọc.
    const current = await this.groupNow(groupId);
    if (current && current.activeMemberIds.includes(userId)) return groupId;

    const b = writeBatch(this.db);
    // joinProofs chứng minh người vào biết mã mời: rules đối chiếu bằng getAfter().
    b.set(this.ref('joinProofs', userId), { code, groupId, at: this.now() });
    b.update(this.ref('groups', groupId), {
      memberOrder: arrayUnion(userId),
      activeMemberIds: arrayUnion(userId),
    });
    try {
      await b.commit();
    } catch (e) {
      // Nhóm đã bị xoá mà mã còn sót, hoặc mã không còn khớp với nhóm.
      if (isPermissionDenied(e) || (e as { code?: string }).code === 'not-found') {
        fail(`Không có nhóm nào dùng mã ${InviteCode.format(code)}.`);
      }
      throw e;
    }

    // Giờ đã là thành viên nên đọc được nhóm để báo cho những người còn lại.
    const g = await this.groupNow(groupId);
    if (g) {
      const others = g.activeMemberIds.filter((id) => id !== userId);
      const docs = await this.inboxDocs(
        userId,
        others.map((id) => ({ to: id, message: `${u.name} đã vào nhóm “${g.name}” bằng mã mời.` })),
      );
      if (docs.length > 0) {
        const nb = writeBatch(this.db);
        for (const d of docs) nb.set(d.ref, d.data);
        await nb.commit();
      }
    }
    return groupId;
  }

  async removeMember(groupId: string, userId: string, actorId: string): Promise<void> {
    const g = (await this.groupNow(groupId)) ?? fail('Nhóm không còn.');
    if (actorId !== g.createdBy) fail('Chỉ người tạo nhóm được xoá thành viên.');
    if (actorId === userId) fail('Muốn ra khỏi nhóm thì dùng “Rời nhóm”.');
    if (!g.activeMemberIds.includes(userId)) return;
    const open = await this.openDebtReason(g, userId);
    if (open != null) fail(`${await this.nameOf(userId)} ${open}, chưa xoá được.`);

    const notices = await this.inboxDocs(actorId, [
      { to: userId, message: `${await this.nameOf(actorId)} đã xoá bạn khỏi nhóm “${g.name}”.` },
    ]);
    const b = writeBatch(this.db);
    b.update(this.ref('groups', groupId), { activeMemberIds: arrayRemove(userId) });
    for (const d of notices) b.set(d.ref, d.data);
    await b.commit();
  }

  async leaveGroup(groupId: string, userId: string): Promise<void> {
    const g = await this.groupNow(groupId);
    if (g == null) return;
    const open = await this.openDebtReason(g, userId);
    if (open != null) fail(`Bạn ${open}. Tất toán xong rồi mới rời nhóm được.`);

    const left = g.activeMemberIds.filter((id) => id !== userId);
    const update: Record<string, unknown> = { activeMemberIds: arrayRemove(userId) };
    if (userId === g.createdBy) {
      // Người tạo rời nhóm: chuyển quyền quản lý cho tài khoản (không phải khách) còn lại đầu tiên;
      // nhóm chỉ còn khách thì giao cho người đầu tiên còn lại.
      let next: string | null = left.length === 0 ? null : left[0];
      for (const id of left) {
        const u = await this.userNow(id);
        if (u && !u.guest) {
          next = id;
          break;
        }
      }
      if (next != null) update.createdBy = next;
    }
    const name = await this.nameOf(userId);
    const notices = await this.inboxDocs(
      userId,
      left.map((id) => ({ to: id, message: `${name} đã rời nhóm “${g.name}”.` })),
    );
    const b = writeBatch(this.db);
    b.update(this.ref('groups', groupId), update);
    for (const d of notices) b.set(d.ref, d.data);
    await b.commit();
  }

  async deleteGroup(groupId: string, actorId: string): Promise<void> {
    const blocker = await this.groupDeleteBlocker(groupId, actorId);
    if (blocker != null) fail(blocker);
    const g = await this.groupNow(groupId);
    if (g == null) return;

    const message = `${await this.nameOf(actorId)} đã xoá nhóm “${g.name}”.`;
    const notices = await this.inboxDocs(
      actorId,
      g.activeMemberIds.filter((id) => id !== actorId).map((id) => ({ to: id, message })),
    );
    const bills = await this.billsOfGroupNow(groupId);
    const statuses = await this.statusesOfGroupNow(groupId);

    // Thông báo trước, rồi hoá đơn và khoản nợ, nhóm xoá sau cùng để rules còn tra được thành viên.
    const ops: ((b: ReturnType<typeof writeBatch>) => void)[] = [];
    for (const d of notices) ops.push((b) => b.set(d.ref, d.data));
    for (const s of statuses) ops.push((b) => b.delete(this.ref('debtStatuses', s.key)));
    for (const bill of bills) ops.push((b) => b.delete(this.ref('bills', bill.id)));
    await this.commitChunks(ops);

    const last = writeBatch(this.db);
    if (g.inviteCode) last.delete(this.ref('inviteCodes', g.inviteCode));
    last.delete(this.ref('groups', groupId));
    await last.commit();
  }

  /** Lý do chưa xoá được nhóm, hoặc null nếu xoá được. */
  private async groupDeleteBlocker(groupId: string, actorId: string): Promise<string | null> {
    const g = await this.groupNow(groupId);
    if (g == null) return 'Nhóm không còn.';
    if (actorId !== g.createdBy) return 'Chỉ người tạo nhóm mới xoá được nhóm.';
    const open = await this.unsettledTotal(g);
    if (open > 0) {
      return `Nhóm còn ${Money.format(open)} chưa xác nhận xong. Tất toán xong rồi mới xoá được nhóm.`;
    }
    return null;
  }

  private async commitChunks(ops: readonly ((b: ReturnType<typeof writeBatch>) => void)[]): Promise<void> {
    for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
      const b = writeBatch(this.db);
      for (const op of ops.slice(i, i + BATCH_LIMIT)) op(b);
      await b.commit();
    }
  }

  /** Các khoản (người nợ, người được trả, số tiền) chưa được xác nhận trong nhóm. */
  private async openLines(g: GroupRecord): Promise<{ debtor: string; creditor: string; amount: number }[]> {
    const status = new Map<string, string>();
    for (const s of await this.statusesOfGroupNow(g.id)) status.set(s.key, s.status);
    const out: { debtor: string; creditor: string; amount: number }[] = [];
    for (const rec of await this.billsOfGroupNow(g.id)) {
      let lines;
      try {
        lines = SplitEngine.split(toBill(rec).spec, g.memberOrder).lines;
      } catch {
        continue; // bản ghi hỏng thì bỏ qua, giống bản Room
      }
      for (const l of lines) {
        if (l.memberId === rec.payerId || l.amount <= 0) continue;
        if (status.get(debtKeyOf(rec.id, l.memberId)) === 'CONFIRMED') continue;
        out.push({ debtor: l.memberId, creditor: rec.payerId, amount: l.amount });
      }
    }
    return out;
  }

  /**
   * Lý do người này chưa rời/xoá được khỏi nhóm ("còn nợ …", "còn được nợ …"), hoặc null nếu mọi khoản
   * liên quan đã xác nhận xong.
   */
  private async openDebtReason(g: GroupRecord, userId: string): Promise<string | null> {
    let owes = 0;
    let owed = 0;
    for (const l of await this.openLines(g)) {
      if (l.debtor === userId) owes += l.amount;
      if (l.creditor === userId) owed += l.amount;
    }
    if (owes > 0) return 'còn nợ ' + Money.format(owes);
    if (owed > 0) return 'còn chờ người khác trả ' + Money.format(owed);
    return null;
  }

  /** Tổng các khoản chưa được xác nhận (CONFIRMED) của mọi người trong nhóm. */
  private async unsettledTotal(g: GroupRecord): Promise<number> {
    let total = 0;
    for (const l of await this.openLines(g)) total += l.amount;
    return total;
  }

  // ---------------------------------------------------------------- hoá đơn

  async saveBill(input: BillInput, actorId: string): Promise<string> {
    const g = await this.groupNow(input.groupId);
    if (g == null || !g.activeMemberIds.includes(actorId)) return fail('Bạn không còn ở trong nhóm này.');
    const order = g.memberOrder;
    const spec = input.spec;
    const invalid = SplitEngine.check(spec, order);
    if (invalid != null) return fail(invalid);
    const result = SplitEngine.split(spec, order);
    if (!result.isSavable()) return fail('Hoá đơn chưa có số tiền.');

    const now = this.now();
    const old = input.id == null ? null : await this.billNow(input.id);
    if (old && actorId !== old.createdBy && actorId !== old.payerId) {
      return fail('Chỉ người tạo hoặc người trả được sửa hoá đơn này.');
    }
    if (old == null) {
      // Hoá đơn mới chỉ gồm thành viên hiện tại (sửa hoá đơn cũ thì người đã rời vẫn giữ phần của mình)
      for (const l of result.lines) {
        if (!g.activeMemberIds.includes(l.memberId) && (l.amount > 0 || l.memberId === spec.payerId)) {
          return fail((await this.nameOf(l.memberId)) + ' không còn ở trong nhóm.');
        }
      }
    }

    const oldAmounts = new Map<string, number>();
    const oldPayer = old?.payerId ?? null;
    if (old) {
      for (const l of SplitEngine.split(toBill(old).spec, order).lines) oldAmounts.set(l.memberId, l.amount);
    }

    const billRef = old ? this.ref('bills', old.id) : doc(collection(this.db, 'bills'));
    const title = input.title.trim() === '' ? 'Hoá đơn' : input.title.trim();
    const record = {
      groupId: input.groupId,
      title,
      payerId: spec.payerId,
      subtotal: spec.subtotal,
      participants: [...spec.participants],
      category: input.category,
      createdBy: old ? old.createdBy : actorId,
      createdAt: input.date > 0 ? input.date : old ? old.createdAt : now,
      updatedAt: now,
    };

    const b = writeBatch(this.db);
    b.set(billRef, record);

    // Sửa hoá đơn: khoản đã xác nhận giữ nguyên; khoản đổi số tiền hoặc đổi người nhận thì quay về PENDING.
    if (old) {
      const payerChanged = spec.payerId !== oldPayer;
      for (const s of await this.statusesOfBillNow(old.id, old.groupId)) {
        if (s.status === 'CONFIRMED') continue;
        const now2 = result.lineOf(s.debtorId);
        const before = oldAmounts.get(s.debtorId);
        if (payerChanged || now2 == null || before === undefined || before !== now2.amount) {
          b.delete(this.ref('debtStatuses', s.key));
        }
      }
    }

    const actorName = await this.nameOf(actorId);
    const notices: Notice[] = [];
    for (const l of result.lines) {
      if (l.memberId === spec.payerId || l.memberId === actorId || l.amount <= 0) continue;
      const before = oldAmounts.get(l.memberId);
      if (old && before !== undefined && before === l.amount && spec.payerId === oldPayer) continue;
      const message = !old
        ? `${actorName} thêm hoá đơn “${title}”: phần của bạn ${Money.format(l.amount)}, trả cho ${await this.nameOf(spec.payerId)}.`
        : `${actorName} sửa hoá đơn “${title}”: phần của bạn giờ là ${Money.format(l.amount)}.`;
      notices.push({ to: l.memberId, message, billId: billRef.id, debtKey: debtKeyOf(billRef.id, l.memberId) });
    }
    for (const d of await this.inboxDocs(actorId, notices)) b.set(d.ref, d.data);
    await b.commit();
    return billRef.id;
  }

  async deleteBill(billId: string, actorId: string): Promise<void> {
    const bill = await this.billNow(billId);
    if (bill == null) return;
    if (actorId !== bill.createdBy && actorId !== bill.payerId) {
      fail('Chỉ người tạo hoặc người trả được xoá hoá đơn này.');
    }
    const statuses = await this.statusesOfBillNow(billId, bill.groupId);
    if (statuses.some((s) => s.status === 'CONFIRMED')) {
      fail('Hoá đơn đã có khoản được xác nhận thanh toán, không xoá được.');
    }
    const b = writeBatch(this.db);
    for (const s of statuses) b.delete(this.ref('debtStatuses', s.key));
    b.delete(this.ref('bills', billId));
    await b.commit();
  }

  // ---------------------------------------------------------------- khoản nợ

  async applyDebtAction(debtKey: string, action: Action, actorId: string): Promise<void> {
    const parts = splitDebtKey(debtKey) ?? fail('Khoản nợ không hợp lệ.');
    const { billId, debtorId } = parts;
    const be = (await this.billNow(billId)) ?? fail('Hoá đơn không còn.');
    const g = await this.groupNow(be.groupId);
    const line = SplitEngine.split(toBill(be).spec, g?.memberOrder ?? []).lineOf(debtorId);
    if (line == null || debtorId === be.payerId || line.amount <= 0) fail('Khoản nợ không còn.');

    const role = PaymentStateMachine.roleOf(actorId, debtorId, be.payerId);
    const amount = Money.format(line.amount);
    const debtorName = await this.nameOf(debtorId);
    const creditorName = await this.nameOf(be.payerId);
    const notice: Notice =
      action === 'MARK_PAID'
        ? { to: be.payerId, message: `${debtorName} báo đã chuyển ${amount} cho “${be.title}”. Mở để xác nhận.` }
        : action === 'CONFIRM'
          ? { to: debtorId, message: `${creditorName} đã xác nhận nhận ${amount} (“${be.title}”). Xong khoản này.` }
          : { to: debtorId, message: `${creditorName} báo chưa nhận được ${amount} (“${be.title}”). Kiểm tra lại giao dịch.` };
    const [inbox] = await this.inboxDocs(actorId, [{ ...notice, billId, debtKey }]);

    // Đọc trạng thái hiện tại và ghi trạng thái mới trong cùng một transaction: hai người bấm cùng lúc
    // không thể nhảy cóc qua máy trạng thái.
    const statusRef = this.ref('debtStatuses', debtKey);
    await runTransaction(this.db, async (tx) => {
      const cur = await tx.get(statusRef);
      const from = parseDebtStatus(cur.exists() ? String(cur.data().status) : undefined) ?? 'PENDING';
      if (!PaymentStateMachine.canApply(from, action, role)) {
        fail('Không thực hiện được thao tác này ở trạng thái hiện tại.');
      }
      tx.set(statusRef, {
        billId,
        groupId: be.groupId,
        debtorId,
        status: PaymentStateMachine.apply(from, action, role),
        updatedAt: this.now(),
      });
      if (inbox) tx.set(inbox.ref, inbox.data);
    });
  }

  async sendReminder(
    recipientId: string,
    fromId: string,
    message: string,
    billId: string | null,
    debtKey: string | null,
  ): Promise<void> {
    const docs = await this.inboxDocs(fromId, [{ to: recipientId, message, billId, debtKey }]);
    if (docs.length === 0) return;
    const b = writeBatch(this.db);
    for (const d of docs) b.set(d.ref, d.data);
    await b.commit();
  }
}

export function isPermissionDenied(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'permission-denied';
}
