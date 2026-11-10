const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const HOLD_PICKUP_DAYS = 7;
const MAX_LOANS = 10;

const DAY = 86400000;
function parse(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = Date.parse(d + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  if (new Date(t).toISOString().slice(0, 10) !== d) return null;
  return t;
}
function addDays(d, n) {
  return new Date(parse(d) + n * DAY).toISOString().slice(0, 10);
}
const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  function sync(date) {
    for (const b of books.values()) {
      while (!b.loan && b.holds.length && b.holds[0].readyUntil !== null && b.holds[0].readyUntil < date) {
        const expired = b.holds.shift().readyUntil;
        if (b.holds.length) b.holds[0].readyUntil = addDays(expired, HOLD_PICKUP_DAYS);
      }
    }
  }

  function check(memberId, bookId, date, needBook = true) {
    if (parse(date) === null) return false;
    if (!members.has(memberId)) return false;
    if (needBook && !books.has(bookId)) return false;
    sync(date);
    return true;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, holds: [] });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (!check(memberId, bookId, date)) return fail('invalid');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (b.loan) return fail('onLoan');
      if (m.owed > 0) return fail('owes');
      let count = 0;
      for (const [id, bk] of books) {
        if (bk.loan && bk.loan.memberId === memberId) {
          count++;
          if (bk.loan.dueDate < date) return fail('overdue');
        }
      }
      if (count >= MAX_LOANS) return fail('limit');
      if (b.holds.length) {
        if (b.holds[0].memberId !== memberId) return fail('reserved');
        b.holds.shift();
        if (b.holds.length) b.holds[0].readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      // remaining holds wait until return
      for (const h of b.holds) h.readyUntil = null;
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!check(memberId, bookId, date)) return fail('invalid');
      const b = books.get(bookId);
      if (!b.loan || b.loan.memberId !== memberId) return fail('notBorrowed');
      const late = Math.max(0, Math.round((parse(date) - parse(b.loan.dueDate)) / DAY));
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      members.get(memberId).owed += fine;
      b.loan = null;
      if (b.holds.length) b.holds[0].readyUntil = addDays(date, HOLD_PICKUP_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!check(memberId, bookId, date)) return fail('invalid');
      const b = books.get(bookId);
      if (!b.loan || b.loan.memberId !== memberId) return fail('notBorrowed');
      if (b.holds.length) return fail('held');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('maxRenewals');
      if (b.loan.dueDate < date) return fail('overdue');
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!check(memberId, bookId, date)) return fail('invalid');
      const b = books.get(bookId);
      if (b.loan && b.loan.memberId === memberId) return fail('ownLoan');
      if (!b.loan && b.holds.length === 0) return fail('available');
      if (b.holds.some((h) => h.memberId === memberId)) return fail('duplicate');
      b.holds.push({ memberId, readyUntil: null });
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (!check(memberId, null, date, false)) return fail('invalid');
      const m = members.get(memberId);
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (!check(memberId, null, date, false)) return fail('invalid');
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: b.loan.dueDate });
        const i = b.holds.findIndex((h) => h.memberId === memberId);
        if (i >= 0) holds.push({ bookId, position: i + 1, readyUntil: b.holds[i].readyUntil });
      }
      return { loans, owed: members.get(memberId).owed, holds };
    },
  };
}
