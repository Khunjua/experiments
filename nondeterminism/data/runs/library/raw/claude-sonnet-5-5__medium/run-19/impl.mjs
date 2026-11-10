const DAY = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 7;

function parse(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = Date.parse(d + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  if (new Date(t).toISOString().slice(0, 10) !== d) return null;
  return t;
}
function fmt(t) {
  return new Date(t).toISOString().slice(0, 10);
}
function addDays(d, n) {
  return fmt(parse(d) + n * DAY);
}
function diffDays(a, b) {
  return Math.round((parse(a) - parse(b)) / DAY);
}

export function createLibrary() {
  const books = new Map(); // bookId -> { loan: {memberId,dueDate,renewals}|null, holds: [{memberId, readyUntil|null}] }
  const members = new Map(); // memberId -> { owed }
  const fail = (reason) => ({ ok: false, reason });

  function advance(date) {
    for (const b of books.values()) {
      while (b.holds.length && b.holds[0].readyUntil !== null && date > b.holds[0].readyUntil) {
        const expired = b.holds.shift().readyUntil;
        if (b.holds.length) b.holds[0].readyUntil = addDays(expired, 1 + PICKUP_DAYS);
      }
    }
  }

  function start(date) {
    if (parse(date) === null) return false;
    advance(date);
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
      if (!start(date)) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (b.holds.length) {
        const h = b.holds[0];
        if (h.memberId !== memberId || h.readyUntil === null) return fail('reserved');
        b.holds.shift();
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!start(date)) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const late = Math.max(0, diffDays(date, b.loan.dueDate));
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      b.loan = null;
      if (b.holds.length) b.holds[0].readyUntil = addDays(date, PICKUP_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!start(date)) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (b.holds.length) return fail('held');
      if (date > b.loan.dueDate) return fail('overdue');
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!start(date)) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.holds.length) return fail('available');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.holds.some((h) => h.memberId === memberId)) return fail('duplicate');
      b.holds.push({ memberId, readyUntil: null });
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (!start(date)) return fail('date');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!start(date)) return fail('date');
      const loans = [], holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: b.loan.dueDate });
        const i = b.holds.findIndex((h) => h.memberId === memberId);
        if (i >= 0) holds.push({ bookId, position: i + 1, readyUntil: b.holds[i].readyUntil });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
