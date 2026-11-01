import { arrayUnion, collection, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { BillSpec, PaymentTarget } from '@/domain';
import { Device, errorOf } from './harness';

const devices: Device[] = [];
async function newUser(name: string): Promise<Device> {
  const d = new Device();
  devices.push(d);
  return d.signUp(name);
}
afterAll(() => Promise.all(devices.map((d) => d.close())));

const equal = (payer: string, subtotal: number, participants: string[]) =>
  new BillSpec({ payerId: payer, subtotal, participants });

/** Nhóm "Đà Lạt" gồm Đạt (người tạo), Minh, Lan và khách Hùng. */
async function dalat() {
  const dat = await newUser('Đạt');
  const minh = await newUser('Minh');
  const lan = await newUser('Lan');
  const groupId = await dat.ledger.createGroup('Đà Lạt', dat.id, [minh.id, lan.id], ['Hùng']);
  const snap = await dat.until((s) => s.group(groupId) != null && s.allMembersOf(groupId).length === 4, 'nhóm');
  const hung = snap.allMembersOf(groupId)[3];
  await Promise.all([minh, lan].map((d) => d.until((s) => s.group(groupId) != null, 'nhóm của ' + d.user.name)));
  return { dat, minh, lan, hung, groupId };
}

describe('tài khoản và tìm kiếm', () => {
  it('tìm đúng số điện thoại, không tìm gần đúng, không thấy khách', async () => {
    const a = await newUser('Đạt');
    const b = await newUser('Tuấn');
    const spaced = b.user.phone.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1 $2 $3');
    const found = await a.ledger.findUserByPhone(spaced);
    expect(found?.id).toBe(b.id);
    expect(found?.name).toBe('Tuấn');

    expect(await a.ledger.findUserByPhone('0900000000')).toBeNull();
    expect((await errorOf(a.ledger.findUserByPhone('123')))?.message).toBe(
      'Số điện thoại không hợp lệ. Nhập đủ 10 số, vd 0904 444 444.',
    );
    // users không cho liệt kê
    expect((await errorOf(getDocs(collection(a.db, 'users'))))?.code).toBe('permission-denied');
  });

  it('nối lại mạng (reconnect) không làm chết listener: vẫn nhận thay đổi từ máy khác', async () => {
    const a = await newUser('Đạt');
    const b = await newUser('Tuấn');
    await a.ledger.reconnect();
    await a.ledger.reconnect();
    const groupId = await b.ledger.createGroup('Sau khi nối lại', b.id, [a.id], []);
    const s = await a.until((x) => x.group(groupId) != null, 'Đạt thấy nhóm mới');
    expect(s.membersOf(groupId)).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('đổi tên và khai QR nhận tiền', async () => {
    const a = await newUser('Đạt');
    expect((await errorOf(a.ledger.renameUser(a.id, '   ')))?.message).toBe('Tên không được để trống.');
    expect((await errorOf(a.ledger.renameUser(a.id, 'x'.repeat(41))))?.message).toBe('Tên tối đa 40 ký tự.');
    await a.ledger.renameUser(a.id, '  Đạt Trần ');
    await a.until((s) => s.name(a.id) === 'Đạt Trần', 'đổi tên');

    const target = new PaymentTarget('970436', '1012345678', 'TRAN TUAN DAT');
    const before = Date.now();
    await a.ledger.setPaymentTarget(a.id, target);
    const s = await a.until((x) => x.paymentTarget(a.id) != null, 'QR');
    expect(s.paymentTarget(a.id)?.accountNo).toBe('1012345678');
    expect(s.user(a.id)?.qrUpdatedAt).toBeGreaterThanOrEqual(before);

    await a.ledger.clearPaymentTarget(a.id);
    const cleared = await a.until((x) => x.paymentTarget(a.id) == null, 'xoá QR');
    expect(cleared.user(a.id)?.qrUpdatedAt).toBe(0);
  });

  it('không sửa được hồ sơ của người khác', async () => {
    const a = await newUser('Đạt');
    const b = await newUser('Minh');
    const e = await errorOf(updateDoc(doc(a.db, 'users', b.id), { name: 'Hacker' }));
    expect(e?.code).toBe('permission-denied');
  });
});

describe('nhóm', () => {
  it('tạo nhóm: người tạo đứng đầu, có khách, mã mời, thông báo cho tài khoản (không cho khách)', async () => {
    const { dat, minh, lan, hung, groupId } = await dalat();
    const s = dat.snap!;
    const g = s.group(groupId)!;
    expect(g.memberOrder).toEqual([dat.id, minh.id, lan.id, hung]);
    expect(g.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(s.user(hung)?.guest).toBe(true);
    expect(s.name(hung)).toBe('Hùng');

    const inbox = await minh.until((x) => x.inboxOf(minh.id).length > 0, 'thông báo');
    expect(inbox.inboxOf(minh.id)[0].message).toBe('Đạt đã thêm bạn vào nhóm “Đà Lạt”.');
    expect(dat.snap!.inboxOf(dat.id)).toHaveLength(0);
  });

  it('chỉ thành viên mới thấy nhóm', async () => {
    const { dat, groupId } = await dalat();
    const outsider = await newUser('Người ngoài');
    const e = await errorOf(getDoc(doc(outsider.db, 'groups', groupId)));
    expect(e?.code).toBe('permission-denied');
    expect(outsider.snap?.groupsOf(outsider.id) ?? []).toHaveLength(0);
    void dat;
  });

  it('thành viên thêm người bằng số điện thoại; người ngoài không tự thêm được', async () => {
    const { dat, minh, groupId } = await dalat();
    const tuan = await newUser('Tuấn');
    const outsider = await newUser('Người ngoài');

    expect((await errorOf(outsider.ledger.addMember(groupId, outsider.id, outsider.id)))?.message).toBe('Nhóm không còn.');
    // ghi thẳng vào Firestore cũng bị chặn
    const e = await errorOf(
      updateDoc(doc(outsider.db, 'groups', groupId), {
        activeMemberIds: arrayUnion(outsider.id),
        memberOrder: arrayUnion(outsider.id),
      }),
    );
    expect(e?.code).toBe('permission-denied');

    await minh.ledger.addMember(groupId, tuan.id, minh.id);
    const s = await tuan.until((x) => x.group(groupId) != null, 'Tuấn thấy nhóm');
    expect(s.membersOf(groupId)).toContain(tuan.id);
    expect((await errorOf(minh.ledger.addMember(groupId, tuan.id, minh.id)))?.message).toBe('Tuấn đã ở trong nhóm.');
    expect(tuan.snap!.inboxOf(tuan.id)[0].message).toBe('Minh đã thêm bạn vào nhóm “Đà Lạt”.');
    void dat;
  });

  it('vào bằng mã mời: gõ thường/gạch nối đều được, mã sai báo lỗi, không có mã thì không vào được', async () => {
    const { dat, groupId } = await dalat();
    const code = dat.snap!.group(groupId)!.inviteCode!;
    const joiner = await newUser('Tuấn');

    expect((await errorOf(joiner.ledger.joinByInviteCode('abc', joiner.id)))?.message).toBe('Mã mời gồm 6 ký tự, vd DAL-AT7.');
    expect((await errorOf(joiner.ledger.joinByInviteCode('AAAAAA', joiner.id)))?.message).toBe('Không có nhóm nào dùng mã AAA-AAA.');

    // biết groupId nhưng không có bằng chứng mã mời: rules chặn
    const sneak = await errorOf(
      updateDoc(doc(joiner.db, 'groups', groupId), {
        activeMemberIds: arrayUnion(joiner.id),
        memberOrder: arrayUnion(joiner.id),
      }),
    );
    expect(sneak?.code).toBe('permission-denied');

    const typed = (code.slice(0, 3) + '-' + code.slice(3)).toLowerCase();
    expect(await joiner.ledger.joinByInviteCode(typed, joiner.id)).toBe(groupId);
    const s = await joiner.until((x) => x.group(groupId) != null, 'vào nhóm');
    expect(s.membersOf(groupId)).toContain(joiner.id);
    // vào lần hai thì trả về id nhóm, không lỗi
    expect(await joiner.ledger.joinByInviteCode(code, joiner.id)).toBe(groupId);
    // người trong nhóm nhận thông báo
    const inbox = await dat.until((x) => x.inboxOf(dat.id).some((m) => m.message.includes('bằng mã mời')), 'thông báo vào nhóm');
    expect(inbox.inboxOf(dat.id)[0].message).toBe('Tuấn đã vào nhóm “Đà Lạt” bằng mã mời.');
  });

  it('không dùng mã của nhóm này để vào nhóm khác', async () => {
    const g1 = await dalat();
    const g2 = await dalat();
    const code1 = g1.dat.snap!.group(g1.groupId)!.inviteCode!;
    const joiner = await newUser('Tuấn');
    const e = await errorOf(
      writeBatch(joiner.db)
        .set(doc(joiner.db, 'joinProofs', joiner.id), { code: code1, groupId: g2.groupId, at: 1 })
        .update(doc(joiner.db, 'groups', g2.groupId), {
          activeMemberIds: arrayUnion(joiner.id),
          memberOrder: arrayUnion(joiner.id),
        })
        .commit(),
    );
    expect(e?.code).toBe('permission-denied');
  });
});

describe('hoá đơn và khoản nợ', () => {
  it('lẩu gà: chia đều 4 người, người trả Minh', async () => {
    const { dat, minh, lan, hung, groupId } = await dalat();
    const members = [dat.id, minh.id, lan.id, hung];
    const billId = await minh.ledger.saveBill(
      { id: null, groupId, title: 'Lẩu gà lá é', spec: equal(minh.id, 1_140_000, members), category: 'AN_UONG', date: 0 },
      minh.id,
    );
    const s = await dat.until((x) => x.ledger().bill(billId) != null, 'hoá đơn');
    const r = s.ledger().splitOf(billId)!;
    expect(r.total).toBe(1_140_000);
    expect(r.lineOf(dat.id)?.amount).toBe(285_000);
    expect(r.lineOf(minh.id)?.amount).toBe(285_000);
    expect(r.isBalanced()).toBe(true);

    expect(s.ledger().owedBy(dat.id, groupId)).toBe(285_000);
    expect(s.ledger().owedTo(minh.id, groupId)).toBe(285_000 * 3 /* Đạt, Lan, Hùng */);
    expect(s.ledger().debt(`${billId}:${dat.id}`)?.status).toBe('PENDING');

    // Đạt và Lan được báo; Minh (người trả) và khách Hùng thì không.
    const inbox = await dat.until((x) => x.inboxOf(dat.id).some((m) => m.billId === billId), 'thông báo hoá đơn');
    const note = inbox.inboxOf(dat.id).find((m) => m.billId === billId)!;
    expect(note.message).toBe('Minh thêm hoá đơn “Lẩu gà lá é”: phần của bạn 285.000đ, trả cho Minh.');
    expect(note.debtKey).toBe(`${billId}:${dat.id}`);
    expect(minh.snap!.inboxOf(minh.id).some((m) => m.billId === billId)).toBe(false);
  });

  it('chia lẻ đồng lưu và đọc lại đúng; tài liệu chỉ có các trường chia đều', async () => {
    const { dat, minh, lan, hung, groupId } = await dalat();
    const id = await dat.ledger.saveBill(
      { id: null, groupId, title: 'Cà phê', spec: equal(dat.id, 100_000, [dat.id, minh.id, lan.id]), category: 'AN_UONG', date: 0 },
      dat.id,
    );
    const s = await lan.until((x) => x.ledger().bill(id) != null, 'hoá đơn');
    const r = s.ledger().splitOf(id)!;
    expect(r.lineOf(dat.id)!.amount).toBe(33_334);
    expect(r.lineOf(minh.id)!.amount).toBe(33_333);
    expect(r.lineOf(lan.id)!.amount).toBe(33_333);
    expect(r.lineOf(hung)).toBeNull();
    const raw = (await getDoc(doc(dat.db, 'bills', id))).data()!;
    expect(Object.keys(raw).sort()).toEqual(
      ['category', 'createdAt', 'createdBy', 'groupId', 'participants', 'payerId', 'subtotal', 'title', 'updatedAt'],
    );
  });

  it('kiểm tra đầu vào: tổng 0, chưa chọn ai, người ngoài nhóm', async () => {
    const { dat, minh, lan, hung, groupId } = await dalat();
    const members = [dat.id, minh.id, lan.id, hung];
    const save = (spec: BillSpec) => dat.ledger.saveBill({ id: null, groupId, title: '', spec, category: 'KHAC', date: 0 }, dat.id);

    expect((await errorOf(save(equal(dat.id, 0, members))))?.message).toBe('Hoá đơn chưa có số tiền.');
    expect((await errorOf(save(equal(dat.id, 1000, []))))?.message).toBe('Chọn ít nhất một người tham gia');

    const outsider = await newUser('Người ngoài');
    expect(
      (await errorOf(outsider.ledger.saveBill({ id: null, groupId, title: 'x', spec: equal(outsider.id, 5000, [outsider.id]), category: 'KHAC', date: 0 }, outsider.id)))?.message,
    ).toBe('Bạn không còn ở trong nhóm này.');
  });

  it('tiêu đề trống thành “Hoá đơn”; ngày chi chọn được', async () => {
    const { dat, groupId } = await dalat();
    const when = Date.now() - 5 * 86_400_000;
    const id = await dat.ledger.saveBill(
      { id: null, groupId, title: '   ', spec: equal(dat.id, 50_000, [dat.id]), category: 'KHAC', date: when },
      dat.id,
    );
    const s = await dat.until((x) => x.ledger().bill(id) != null);
    expect(s.ledger().bill(id)!.title).toBe('Hoá đơn');
    expect(s.ledger().bill(id)!.createdAt).toBe(when);
  });

  it('chỉ người tạo hoặc người trả sửa/xoá hoá đơn, cả ở repository lẫn rules', async () => {
    const { dat, minh, lan, hung, groupId } = await dalat();
    const members = [dat.id, minh.id, lan.id, hung];
    const id = await minh.ledger.saveBill(
      { id: null, groupId, title: 'Lẩu', spec: equal(minh.id, 400_000, members), category: 'AN_UONG', date: 0 }, minh.id);
    await lan.until((x) => x.ledger().bill(id) != null);

    const edit = { id, groupId, title: 'Lẩu 2', spec: equal(minh.id, 500_000, members), category: 'AN_UONG' as const, date: 0 };
    expect((await errorOf(lan.ledger.saveBill(edit, lan.id)))?.message).toBe('Chỉ người tạo hoặc người trả được sửa hoá đơn này.');
    expect((await errorOf(lan.ledger.deleteBill(id, lan.id)))?.message).toBe('Chỉ người tạo hoặc người trả được xoá hoá đơn này.');
    expect((await errorOf(updateDoc(doc(lan.db, 'bills', id), { subtotal: 1 })))?.code).toBe('permission-denied');
    expect((await errorOf(setDoc(doc(lan.db, 'bills', 'forged'), { groupId, createdBy: minh.id, payerId: minh.id, title: 'x' })))?.code).toBe('permission-denied');

    await minh.ledger.saveBill(edit, minh.id);
    const s = await lan.until((x) => x.ledger().bill(id)?.title === 'Lẩu 2');
    expect(s.ledger().splitOf(id)!.total).toBe(500_000);
    // Lan được báo phần mới
    const inbox = await lan.until((x) => x.inboxOf(lan.id).some((m) => m.message.includes('sửa hoá đơn')));
    expect(inbox.inboxOf(lan.id)[0].message).toBe('Minh sửa hoá đơn “Lẩu 2”: phần của bạn giờ là 125.000đ.');
  });

  it('máy trạng thái thanh toán: đúng vai trò, đúng thứ tự, đúng thông điệp', async () => {
    const { dat, minh, lan, hung, groupId } = await dalat();
    const members = [dat.id, minh.id, lan.id, hung];
    const id = await minh.ledger.saveBill(
      { id: null, groupId, title: 'Lẩu', spec: equal(minh.id, 400_000, members), category: 'AN_UONG', date: 0 }, minh.id);
    await lan.until((x) => x.ledger().debt(`${id}:${lan.id}`) != null);
    const key = `${id}:${lan.id}`;
    const notSupported = 'Không thực hiện được thao tác này ở trạng thái hiện tại.';

    // Minh (người được trả) không tự báo "đã chuyển"; Đạt (người khác) không động vào được.
    expect((await errorOf(minh.ledger.applyDebtAction(key, 'MARK_PAID', minh.id)))?.message).toBe(notSupported);
    expect((await errorOf(dat.ledger.applyDebtAction(key, 'CONFIRM', dat.id)))?.message).toBe(notSupported);
    expect((await errorOf(lan.ledger.applyDebtAction(key, 'CONFIRM', lan.id)))?.message).toBe(notSupported);
    expect((await errorOf(lan.ledger.applyDebtAction(key, 'DISPUTE', lan.id)))?.message).toBe(notSupported);
    expect((await errorOf(minh.ledger.applyDebtAction(`${id}:${minh.id}`, 'CONFIRM', minh.id)))?.message).toBe('Khoản nợ không còn.');
    expect((await errorOf(minh.ledger.applyDebtAction('hỏng', 'CONFIRM', minh.id)))?.message).toBe('Khoản nợ không hợp lệ.');
    expect((await errorOf(minh.ledger.applyDebtAction('nope:x', 'CONFIRM', minh.id)))?.message).toBe('Hoá đơn không còn.');

    // rules chặn cả khi ghi thẳng: Lan không tự đặt CONFIRMED
    const forged = await errorOf(setDoc(doc(lan.db, 'debtStatuses', key), { billId: id, groupId, debtorId: lan.id, status: 'CONFIRMED', updatedAt: 1 }));
    expect(forged?.code).toBe('permission-denied');

    await lan.ledger.applyDebtAction(key, 'MARK_PAID', lan.id);
    await minh.until((x) => x.ledger().debt(key)?.status === 'MARKED_PAID');
    const toMinh = minh.snap!.inboxOf(minh.id)[0].message;
    expect(toMinh).toBe('Lan báo đã chuyển 100.000đ cho “Lẩu”. Mở để xác nhận.');

    await minh.ledger.applyDebtAction(key, 'DISPUTE', minh.id);
    await lan.until((x) => x.ledger().debt(key)?.status === 'DISPUTED');
    expect(lan.snap!.inboxOf(lan.id)[0].message).toBe('Minh báo chưa nhận được 100.000đ (“Lẩu”). Kiểm tra lại giao dịch.');

    await lan.ledger.applyDebtAction(key, 'MARK_PAID', lan.id); // DISPUTED → MARKED_PAID
    await minh.until((x) => x.ledger().debt(key)?.status === 'MARKED_PAID');
    await minh.ledger.applyDebtAction(key, 'CONFIRM', minh.id);
    const s = await lan.until((x) => x.ledger().debt(key)?.status === 'CONFIRMED');
    expect(lan.snap!.inboxOf(lan.id)[0].message).toBe('Minh đã xác nhận nhận 100.000đ (“Lẩu”). Xong khoản này.');
    expect(s.ledger().owedBy(lan.id, groupId)).toBe(0);
    expect((await errorOf(minh.ledger.applyDebtAction(key, 'CONFIRM', minh.id)))?.message).toBe(notSupported);

    // người được trả nhận tiền mặt: PENDING → CONFIRMED thẳng (khoản của Đạt)
    await minh.ledger.applyDebtAction(`${id}:${dat.id}`, 'CONFIRM', minh.id);
    await dat.until((x) => x.ledger().debt(`${id}:${dat.id}`)?.status === 'CONFIRMED');
  });

  it('sửa hoá đơn: khoản đã xác nhận giữ nguyên, khoản đổi tiền hoặc người trả quay về chưa trả', async () => {
    const { dat, minh, lan, hung, groupId } = await dalat();
    const members = [dat.id, minh.id, lan.id, hung];
    const spec = (subtotal: number, payer = minh.id) => equal(payer, subtotal, members);
    const id = await minh.ledger.saveBill({ id: null, groupId, title: 'Lẩu', spec: spec(400_000), category: 'AN_UONG', date: 0 }, minh.id);
    await lan.until((x) => x.ledger().debt(`${id}:${lan.id}`) != null);
    await minh.ledger.applyDebtAction(`${id}:${dat.id}`, 'CONFIRM', minh.id);
    await lan.ledger.applyDebtAction(`${id}:${lan.id}`, 'MARK_PAID', lan.id);
    await minh.until((x) => x.ledger().debt(`${id}:${lan.id}`)?.status === 'MARKED_PAID' && x.ledger().debt(`${id}:${dat.id}`)?.status === 'CONFIRMED');

    // đổi số tiền: Đạt đã xác nhận giữ nguyên, Lan quay về PENDING
    await minh.ledger.saveBill({ id, groupId, title: 'Lẩu', spec: spec(480_000), category: 'AN_UONG', date: 0 }, minh.id);
    const s = await minh.until((x) => x.ledger().splitOf(id)?.total === 480_000 && x.ledger().debt(`${id}:${lan.id}`)?.status === 'PENDING');
    expect(s.ledger().debt(`${id}:${dat.id}`)?.status).toBe('CONFIRMED');
    expect(s.ledger().debt(`${id}:${dat.id}`)?.amount).toBe(120_000);

    // không đổi gì → không báo lại, không đổi trạng thái
    await lan.ledger.applyDebtAction(`${id}:${lan.id}`, 'MARK_PAID', lan.id);
    await minh.until((x) => x.ledger().debt(`${id}:${lan.id}`)?.status === 'MARKED_PAID');
    await minh.ledger.saveBill({ id, groupId, title: 'Lẩu (đổi tên)', spec: spec(480_000), category: 'AN_UONG', date: 0 }, minh.id);
    await minh.until((x) => x.ledger().bill(id)?.title === 'Lẩu (đổi tên)');
    expect(minh.snap!.ledger().debt(`${id}:${lan.id}`)?.status).toBe('MARKED_PAID');

    // đổi người trả: mọi khoản chưa xác nhận quay về PENDING
    await minh.ledger.saveBill({ id, groupId, title: 'Lẩu (đổi tên)', spec: spec(480_000, dat.id), category: 'AN_UONG', date: 0 }, minh.id);
    const swapped = await minh.until((x) => x.ledger().bill(id)?.payerId === dat.id);
    expect(swapped.ledger().debt(`${id}:${lan.id}`)?.status).toBe('PENDING');
    expect(swapped.ledger().debt(`${id}:${lan.id}`)?.creditorId).toBe(dat.id);
  });

  it('không xoá được hoá đơn đã có khoản xác nhận; xoá được khi chưa', async () => {
    const { dat, minh, lan, hung, groupId } = await dalat();
    const members = [dat.id, minh.id, lan.id, hung];
    const mk = async (title: string) => {
      const id = await minh.ledger.saveBill({ id: null, groupId, title, spec: equal(minh.id, 400_000, members), category: 'KHAC', date: 0 }, minh.id);
      await lan.until((x) => x.ledger().debt(`${id}:${lan.id}`) != null);
      return id;
    };
    const keep = await mk('Giữ');
    await minh.ledger.applyDebtAction(`${keep}:${lan.id}`, 'CONFIRM', minh.id);
    expect((await errorOf(minh.ledger.deleteBill(keep, minh.id)))?.message).toBe('Hoá đơn đã có khoản được xác nhận thanh toán, không xoá được.');

    const drop = await mk('Xoá');
    await lan.ledger.applyDebtAction(`${drop}:${lan.id}`, 'MARK_PAID', lan.id);
    await minh.until((x) => x.ledger().debt(`${drop}:${lan.id}`)?.status === 'MARKED_PAID');
    await minh.ledger.deleteBill(drop, minh.id);
    const s = await lan.until((x) => x.ledger().bill(drop) == null && x.ledger().bill(keep) != null);
    expect(s.ledger().debt(`${drop}:${lan.id}`)).toBeUndefined();
    await minh.ledger.deleteBill(drop, minh.id); // đã xoá thì im lặng
  });

  it('nhắc nợ: tài khoản nhận được, khách thì không', async () => {
    const { dat, minh, hung } = await dalat();
    await minh.ledger.sendReminder(dat.id, minh.id, 'Nhớ trả tiền nhé', null, null);
    await minh.ledger.sendReminder(hung, minh.id, 'Khách không có hộp thư', null, null);
    const s = await dat.until((x) => x.inboxOf(dat.id).some((m) => m.message === 'Nhớ trả tiền nhé'));
    expect(s.inboxOf(dat.id).filter((m) => m.message === 'Nhớ trả tiền nhé')).toHaveLength(1);
    expect(s.user(hung)?.guest).toBe(true);
  });
});

describe('rời nhóm, xoá thành viên, xoá nhóm', () => {
  async function withDebt() {
    const ctx = await dalat();
    const { dat, minh, lan, hung, groupId } = ctx;
    const members = [dat.id, minh.id, lan.id, hung];
    const billId = await minh.ledger.saveBill(
      { id: null, groupId, title: 'Lẩu', spec: equal(minh.id, 400_000, members), category: 'AN_UONG', date: 0 }, minh.id);
    await Promise.all([dat, lan].map((d) => d.until((x) => x.ledger().debt(`${billId}:${d.id}`) != null)));
    return { ...ctx, billId };
  }

  it('không rời/xoá được khi còn nợ hoặc còn được nợ; xong hết thì được', async () => {
    const { dat, minh, lan, hung, groupId, billId } = await withDebt();
    expect((await errorOf(lan.ledger.leaveGroup(groupId, lan.id)))?.message).toBe('Bạn còn nợ 100.000đ. Tất toán xong rồi mới rời nhóm được.');
    expect((await errorOf(minh.ledger.leaveGroup(groupId, minh.id)))?.message).toBe('Bạn còn chờ người khác trả 300.000đ. Tất toán xong rồi mới rời nhóm được.');
    expect((await errorOf(dat.ledger.removeMember(groupId, lan.id, dat.id)))?.message).toBe('Lan còn nợ 100.000đ, chưa xoá được.');
    expect((await errorOf(lan.ledger.removeMember(groupId, dat.id, lan.id)))?.message).toBe('Chỉ người tạo nhóm được xoá thành viên.');
    expect((await errorOf(dat.ledger.removeMember(groupId, dat.id, dat.id)))?.message).toBe('Muốn ra khỏi nhóm thì dùng “Rời nhóm”.');

    for (const d of [lan, dat]) await minh.ledger.applyDebtAction(`${billId}:${d.id}`, 'CONFIRM', minh.id);
    await minh.ledger.applyDebtAction(`${billId}:${hung}`, 'CONFIRM', minh.id);
    await lan.until((x) => x.ledger().openDebtCount(groupId) === 0);

    await dat.ledger.removeMember(groupId, lan.id, dat.id);
    await lan.until((x) => x.group(groupId) == null, 'Lan mất nhóm');
    expect(lan.snap!.inboxOf(lan.id)[0].message).toBe('Đạt đã xoá bạn khỏi nhóm “Đà Lạt”.');
    // người đã rời vẫn nằm trong thứ tự chia
    const s = await dat.until((x) => !x.membersOf(groupId).includes(lan.id));
    expect(s.allMembersOf(groupId)).toContain(lan.id);
    expect(s.ledger().bill(billId)).toBeDefined();
    expect(s.ledger().splitOf(billId)!.lineOf(lan.id)!.amount).toBe(100_000); // hoá đơn cũ không đổi
  });

  it('người rời nhóm vẫn đứng đúng chỗ khi quay lại bằng mã mời; hoá đơn mới không gồm người đã rời', async () => {
    const { dat, minh, lan, hung, groupId, billId } = await withDebt();
    for (const id of [dat.id, lan.id, hung]) await minh.ledger.applyDebtAction(`${billId}:${id}`, 'CONFIRM', minh.id);
    await lan.until((x) => x.ledger().openDebtCount(groupId) === 0);
    const code = dat.snap!.group(groupId)!.inviteCode!;

    await lan.ledger.leaveGroup(groupId, lan.id);
    await dat.until((x) => !x.membersOf(groupId).includes(lan.id));
    await dat.until((x) => x.inboxOf(dat.id).some((m) => m.message === 'Lan đã rời nhóm “Đà Lạt”.'), 'thông báo rời nhóm');
    const e = await errorOf(dat.ledger.saveBill({ id: null, groupId, title: 'Mới', spec: equal(dat.id, 90_000, [dat.id, lan.id]), category: 'KHAC', date: 0 }, dat.id));
    expect(e?.message).toBe('Lan không còn ở trong nhóm.');

    await lan.ledger.joinByInviteCode(code, lan.id);
    const s = await dat.until((x) => x.membersOf(groupId).includes(lan.id));
    expect(s.allMembersOf(groupId)).toEqual([dat.id, minh.id, lan.id, hung]); // vị trí cũ
    expect(s.allMembersOf(groupId)).toHaveLength(4);
  });

  it('người tạo rời nhóm: chuyển quyền cho tài khoản (không phải khách) đầu tiên còn lại', async () => {
    const { dat, minh, lan, hung, groupId, billId } = await withDebt();
    for (const id of [dat.id, lan.id, hung]) await minh.ledger.applyDebtAction(`${billId}:${id}`, 'CONFIRM', minh.id);
    await dat.until((x) => x.ledger().openDebtCount(groupId) === 0);
    await dat.ledger.leaveGroup(groupId, dat.id);
    const s = await minh.until((x) => x.group(groupId)?.createdBy === minh.id, 'chuyển quyền');
    expect(s.membersOf(groupId)).not.toContain(dat.id);
    void lan;
  });

  it('xoá nhóm: chỉ người tạo, chỉ khi đã tất toán; mọi dữ liệu biến mất và thành viên được báo', async () => {
    const { dat, minh, lan, hung, groupId, billId } = await withDebt();
    expect((await errorOf(lan.ledger.deleteGroup(groupId, lan.id)))?.message).toBe('Chỉ người tạo nhóm mới xoá được nhóm.');
    expect((await errorOf(dat.ledger.deleteGroup(groupId, dat.id)))?.message).toBe(
      'Nhóm còn 300.000đ chưa xác nhận xong. Tất toán xong rồi mới xoá được nhóm.');

    for (const id of [dat.id, lan.id, hung]) await minh.ledger.applyDebtAction(`${billId}:${id}`, 'CONFIRM', minh.id);
    await dat.until((x) => x.ledger().openDebtCount(groupId) === 0);
    const code = dat.snap!.group(groupId)!.inviteCode!;

    await dat.ledger.deleteGroup(groupId, dat.id);
    for (const d of [dat, minh, lan]) {
      const s = await d.until((x) => x.group(groupId) == null, 'nhóm biến mất của ' + d.user.name);
      expect(s.ledger().bill(billId)).toBeUndefined();
    }
    expect(minh.snap!.inboxOf(minh.id).some((m) => m.message === 'Đạt đã xoá nhóm “Đà Lạt”.')).toBe(true);
    expect((await getDoc(doc(dat.db, 'bills', billId))).exists()).toBe(false);
    expect((await errorOf(lan.ledger.joinByInviteCode(code, lan.id)))?.message).toMatch(/^Không có nhóm nào dùng mã/);
    expect((await errorOf(dat.ledger.deleteGroup(groupId, dat.id)))?.message).toBe('Nhóm không còn.');
  });
});

describe('hộp thư', () => {
  it('chỉ đọc được thư của mình', async () => {
    const a = await newUser('Đạt');
    const b = await newUser('Minh');
    await a.ledger.sendReminder(b.id, a.id, 'Chào Minh', null, null);
    const s = await b.until((x) => x.inboxOf(b.id).length > 0);
    const noteId = s.inboxOf(b.id)[0].id;
    expect((await errorOf(getDoc(doc(a.db, 'inbox', noteId))))?.code).toBe('permission-denied');
    expect((await errorOf(setDoc(doc(a.db, 'inbox', 'giả'), { recipientId: b.id, fromId: b.id, message: 'giả mạo', createdAt: 1 })))?.code).toBe('permission-denied');
  });
});
