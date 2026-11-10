const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const PICKUP_DAYS = 3;

function parse(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, dd] = d.split('-').map(Number);
  const t = Date.UTC(y, m - 1, dd);
  const o = new Date(t);
  if (o.getUTCFullYear() !== y || o.getUTCMonth() !== m - 1 || o.getUTCDate() !== dd) return null;
  return t / 86400000;
}
function fmt(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}
function addDays(s, n) {
  return fmt(parse(s) + n);
}

export function createLibrary() {
  const books = new Map(); // id -> { loan: {memberId,dueDate,renewals}|null, queue: [{memberId, readyUntil}] }
  const members = new Map(); // id -> { owed, loans: Map(bookId->true) }
  const fail = (reason) => ({ ok: false, reason });

  function advance(date) {
    for (const b of books.values()) {
      const q = b.queue;
      while (q.length && q[0].readyUntil && parse(q[0].readyUntil) < parse(date)) {
        const old = q.shift();
        if (q.length) q[0].readyUntil = addDays(old.readyUntil, 1 + PICKUP_DAYS);
      }
    }
  }
  function pre(date, memberId, bookId) {
    if (parse(date) === null) return 'bad date';
    advance(date);
    if (memberId !== undefined && !members.has(memberId)) return 'no member';
    if (bookId !== undefined && !books.has(bookId)) return 'no book';
    return null;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0, loans: new Map() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const e = pre(date, memberId, bookId);
      if (e) return fail(e);
      const m = members.get(memberId), b = books.get(bookId);
      if (b.loan) return fail('on loan');
      if (m.owed >= BLOCK_OWED) return fail('owes too much');
      if (m.loans.size >= MAX_LOANS) return fail('limit');
      for (const bid of m.loans.keys()) {
        if (parse(books.get(bid).loan.dueDate) < parse(date)) return fail('overdue loan');
      }
      if (b.queue.length) {
        const first = b.queue[0];
        if (first.memberId !== memberId) return fail('held for another');
        b.queue.shift();
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.set(bookId, true);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const e = pre(date, memberId, bookId);
      if (e) return fail(e);
      const m = members.get(memberId), b = books.get(bookId);
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const late = parse(date) - parse(b.loan.dueDate);
      const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.queue.length) b.queue[0].readyUntil = addDays(date, PICKUP_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const e = pre(date, memberId, bookId);
      if (e) return fail(e);
      const b = books.get(bookId);
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('max renewals');
      if (parse(date) > parse(b.loan.dueDate)) return fail('overdue');
      if (b.queue.length) return fail('held by others');
      if (members.get(memberId).owed >= BLOCK_OWED) return fail('owes too much');
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const e = pre(date, memberId, bookId);
      if (e) return fail(e);
      const b = books.get(bookId);
      if (!b.loan) return fail('available');
      if (b.loan.memberId === memberId) return fail('already have it');
      if (b.queue.some((h) => h.memberId === memberId)) return fail('already held');
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const e = pre(date, memberId);
      if (e) return fail(e);
      const m = members.get(memberId);
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('bad amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const e = pre(date, memberId);
      if (e) return { ok: false, reason: e, loans: [], owed: 0, holds: [] };
      const m = members.get(memberId);
      const loans = [];
      for (const bid of m.loans.keys()) loans.push({ bookId: bid, dueDate: books.get(bid).loan.dueDate });
      const holds = [];
      for (const [bid, b] of books) {
        const i = b.queue.findIndex((h) => h.memberId === memberId);
        if (i >= 0) holds.push({ bookId: bid, position: i + 1, readyUntil: b.queue[i].readyUntil });
      }
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
