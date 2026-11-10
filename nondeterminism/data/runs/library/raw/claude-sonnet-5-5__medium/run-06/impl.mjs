const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 7;
const MAX_LOANS = 10;
const BORROW_BLOCK_OWED = 500;

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
function add(d, n) {
  return fmt(parse(d) + n);
}

export function createLibrary() {
  const books = new Map(); // bookId -> { loan: {memberId,dueDate,renewals}|null, queue: [{memberId, readyUntil}] }
  const members = new Map(); // memberId -> { owed }
  const FAIL = (reason) => ({ ok: false, reason });

  function expire(today) {
    const t = parse(today);
    for (const b of books.values()) {
      while (b.queue.length && b.queue[0].readyUntil !== null && parse(b.queue[0].readyUntil) < t) {
        const old = b.queue.shift();
        if (b.queue.length) b.queue[0].readyUntil = add(old.readyUntil, 1 + PICKUP_DAYS);
      }
    }
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return FAIL('invalid');
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return FAIL('invalid');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return FAIL('date');
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.loan) return FAIL('out');
      if (m.owed >= BORROW_BLOCK_OWED) return FAIL('owes');
      let count = 0;
      for (const bk of books.values()) if (bk.loan && bk.loan.memberId === memberId) count++;
      if (count >= MAX_LOANS) return FAIL('limit');
      if (b.queue.length) {
        if (b.queue[0].memberId !== memberId) return FAIL('reserved');
        b.queue.shift();
        if (b.queue.length) {
          // remaining waiters stay waiting; the book is out again
          b.queue.forEach((e) => (e.readyUntil = null));
        }
      }
      const dueDate = add(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return FAIL('date');
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return FAIL('noloan');
      const late = parse(date) - parse(b.loan.dueDate);
      const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;
      m.owed += fine;
      b.loan = null;
      if (b.queue.length) b.queue[0].readyUntil = add(date, PICKUP_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return FAIL('date');
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return FAIL('noloan');
      if (b.queue.length) return FAIL('waiting');
      if (b.loan.renewals >= MAX_RENEWALS) return FAIL('max');
      if (parse(date) > parse(b.loan.dueDate)) return FAIL('overdue');
      b.loan.renewals++;
      b.loan.dueDate = add(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return FAIL('date');
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan) return FAIL('available');
      if (b.loan.memberId === memberId) return FAIL('own');
      if (b.queue.some((e) => e.memberId === memberId)) return FAIL('dup');
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (parse(date) === null) return FAIL('date');
      expire(date);
      const m = members.get(memberId);
      if (!m) return FAIL('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return FAIL('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      if (parse(date) !== null) expire(date);
      const loans = [], holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: b.loan.dueDate });
        const i = b.queue.findIndex((e) => e.memberId === memberId);
        if (i >= 0) holds.push({ bookId, position: i + 1, readyUntil: b.queue[i].readyUntil });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
