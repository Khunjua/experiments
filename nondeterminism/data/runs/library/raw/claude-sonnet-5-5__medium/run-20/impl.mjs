const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const HOLD_PICKUP_DAYS = 7;
const MAX_LOANS = 10;
const BORROW_BLOCK_OWED = 500;

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function dayNum(s) {
  return Math.round(Date.parse(s + 'T00:00:00Z') / 86400000);
}
function addDays(s, n) {
  return new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  const FAIL = (reason) => ({ ok: false, reason });

  function advance(date) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && date > b.readyUntil) {
        b.queue.shift();
        b.readyUntil = b.queue.length ? addDays(b.readyUntil, HOLD_PICKUP_DAYS) : null;
      }
    }
  }

  function ctx(memberId, bookId, date, needBook = true) {
    if (!validDate(date)) return null;
    advance(date);
    const m = members.get(memberId);
    if (!m) return null;
    let b = null;
    if (needBook) {
      b = books.get(bookId);
      if (!b) return null;
    }
    return { m, b };
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return FAIL('invalid');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return FAIL('invalid');
      members.set(memberId, { loans: new Map(), owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const c = ctx(memberId, bookId, date);
      if (!c) return FAIL('invalid');
      const { m, b } = c;
      if (b.loan) return FAIL('on loan');
      if (b.readyUntil !== null && b.queue[0] !== memberId) return FAIL('set aside for other');
      if (m.owed >= BORROW_BLOCK_OWED) return FAIL('owes');
      if (m.loans.size >= MAX_LOANS) return FAIL('limit');
      for (const l of m.loans.values()) if (l.dueDate < date) return FAIL('overdue');
      if (b.readyUntil !== null) {
        b.queue.shift();
        b.readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.set(bookId, b.loan);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const c = ctx(memberId, bookId, date);
      if (!c) return FAIL('invalid');
      const { m, b } = c;
      if (!b.loan || b.loan.memberId !== memberId) return FAIL('not borrowed');
      const late = Math.max(0, dayNum(date) - dayNum(b.loan.dueDate));
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.queue.length) b.readyUntil = addDays(date, HOLD_PICKUP_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const c = ctx(memberId, bookId, date);
      if (!c) return FAIL('invalid');
      const { b } = c;
      const l = b.loan;
      if (!l || l.memberId !== memberId) return FAIL('not borrowed');
      if (b.queue.length) return FAIL('holds');
      if (l.renewals >= MAX_RENEWALS) return FAIL('max renewals');
      if (date > l.dueDate) return FAIL('overdue');
      l.dueDate = addDays(l.dueDate, LOAN_DAYS);
      l.renewals++;
      return { ok: true, dueDate: l.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const c = ctx(memberId, bookId, date);
      if (!c) return FAIL('invalid');
      const { b } = c;
      if (!b.loan && b.readyUntil === null) return FAIL('available');
      if (b.loan && b.loan.memberId === memberId) return FAIL('own loan');
      if (b.queue.includes(memberId)) return FAIL('already held');
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const c = ctx(memberId, null, date, false);
      if (!c) return FAIL('invalid');
      if (!Number.isInteger(amount) || amount <= 0 || amount > c.m.owed) return FAIL('bad amount');
      c.m.owed -= amount;
      return { ok: true, owed: c.m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (validDate(date)) advance(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      for (const [bookId, l] of m.loans) loans.push({ bookId, dueDate: l.dueDate });
      const holds = [];
      for (const [bookId, b] of books) {
        const i = b.queue.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: i === 0 && b.readyUntil !== null ? b.readyUntil : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
