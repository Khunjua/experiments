const MS = 86400000;
const parse = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return t;
};
const fmt = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (s, n) => fmt(parse(s) + n * MS);

const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const HOLD_DAYS = 7;
const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  function advance(date) {
    for (const b of books.values()) {
      while (!b.loan && b.holds.length > 0 && b.readyUntil !== null && b.readyUntil < date) {
        b.holds.shift();
        if (b.holds.length > 0) b.readyUntil = addDays(b.readyUntil, HOLD_DAYS);
        else b.readyUntil = null;
      }
    }
  }

  function hasOverdue(m, date) {
    for (const [bookId, l] of m.loans) if (l.dueDate < date) return true;
    return false;
  }

  function check(memberId, bookId, date, needBook = true) {
    if (parse(date) === null) return fail('bad date');
    const m = members.get(memberId);
    if (!m) return fail('no member');
    const b = needBook ? books.get(bookId) : null;
    if (needBook && !b) return fail('no book');
    advance(date);
    return { m, b };
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { loans: new Map(), owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const c = check(memberId, bookId, date);
      if (!c.m) return c;
      const { m, b } = c;
      if (b.loan) return fail('out');
      if (m.owed > 0) return fail('owes');
      if (hasOverdue(m, date)) return fail('overdue');
      if (b.holds.length > 0) {
        if (b.holds[0] !== memberId) return fail('set aside for other');
        b.holds.shift();
        b.readyUntil = null;
        if (b.holds.length > 0) {
          // should not happen while available; keep queue consistent
          b.readyUntil = null;
        }
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.set(bookId, b.loan);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const c = check(memberId, bookId, date);
      if (!c.m) return c;
      const { m, b } = c;
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const late = Math.round((parse(date) - parse(b.loan.dueDate)) / MS);
      const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.holds.length > 0) b.readyUntil = addDays(date, HOLD_DAYS);
      else b.readyUntil = null;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const c = check(memberId, bookId, date);
      if (!c.m) return c;
      const { m, b } = c;
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      if (b.holds.length > 0) return fail('held');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (date > b.loan.dueDate) return fail('overdue');
      if (m.owed > 0) return fail('owes');
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const c = check(memberId, bookId, date);
      if (!c.m) return c;
      const { b } = c;
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.holds.includes(memberId)) return fail('duplicate');
      if (!b.loan && b.holds.length === 0) return fail('available');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const c = check(memberId, null, date, false);
      if (!c.m) return c;
      if (!Number.isInteger(amount) || amount <= 0 || amount > c.m.owed) return fail('bad amount');
      c.m.owed -= amount;
      return { ok: true, owed: c.m.owed };
    },
    getMember({ memberId, date } = {}) {
      const c = check(memberId, null, date, false);
      if (!c.m) return c;
      const { m } = c;
      const loans = [];
      for (const [bookId, l] of m.loans) loans.push({ bookId, dueDate: l.dueDate });
      const holds = [];
      for (const [bookId, b] of books) {
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: i === 0 && !b.loan ? b.readyUntil : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
