const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const HOLD_PICKUP_DAYS = 3;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

function fmtDate(days) {
  return new Date(days * 86400000).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fmtDate(parseDate(s) + n);
}

export function createLibrary() {
  const books = new Map(); // bookId -> { loan, holds: [], readyUntil }
  const members = new Map(); // memberId -> { owed, loans: Map(bookId -> loan) }
  const fail = (reason) => ({ ok: false, reason });

  function process(date) {
    for (const b of books.values()) {
      while (b.holds.length && b.readyUntil !== null && b.readyUntil < date) {
        const prev = b.readyUntil;
        b.holds.shift();
        if (b.holds.length) b.readyUntil = addDays(prev, 1 + HOLD_PICKUP_DAYS);
        else b.readyUntil = null;
      }
    }
  }

  function ctx(date, memberId, bookId, needBook = true) {
    if (parseDate(date) === null) return null;
    process(date);
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
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0, loans: new Map() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const c = ctx(date, memberId, bookId);
      if (!c) return fail('unknown');
      const { m, b } = c;
      if (b.loan) return fail('on loan');
      if (m.owed > 0) return fail('owes fines');
      if (b.holds.length) {
        // book is set aside for first holder
        if (b.holds[0] !== memberId) return fail('set aside for another member');
        b.holds.shift();
        b.readyUntil = null;
        if (b.holds.length) {
          // remaining holders wait for the book to come back
        }
      }
      const dueDate = addDays(date, LOAN_DAYS);
      const loan = { memberId, bookId, dueDate, renewals: 0 };
      b.loan = loan;
      m.loans.set(bookId, loan);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const c = ctx(date, memberId, bookId);
      if (!c) return fail('unknown');
      const { m, b } = c;
      const loan = b.loan;
      if (!loan || loan.memberId !== memberId) return fail('not borrowed');
      const late = parseDate(date) - parseDate(loan.dueDate);
      let fine = 0;
      if (late > 0) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.holds.length) b.readyUntil = addDays(date, HOLD_PICKUP_DAYS);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const c = ctx(date, memberId, bookId);
      if (!c) return fail('unknown');
      const { b } = c;
      const loan = b.loan;
      if (!loan || loan.memberId !== memberId) return fail('not borrowed');
      if (loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (b.holds.length) return fail('held');
      if (date > loan.dueDate) return fail('overdue');
      loan.renewals++;
      loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const c = ctx(date, memberId, bookId);
      if (!c) return fail('unknown');
      const { b } = c;
      if (!b.loan) return fail('available');
      if (b.loan.memberId === memberId) return fail('already borrowed');
      if (b.holds.includes(memberId)) return fail('duplicate');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const c = ctx(date, memberId, null, false);
      if (!c) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > c.m.owed) return fail('bad amount');
      c.m.owed -= amount;
      return { ok: true, owed: c.m.owed };
    },

    getMember({ memberId, date } = {}) {
      const c = ctx(date, memberId, null, false);
      if (!c) return { ok: false, loans: [], owed: 0, holds: [] };
      const loans = [...c.m.loans.values()].map((l) => ({ bookId: l.bookId, dueDate: l.dueDate }));
      const holds = [];
      for (const [bookId, b] of books) {
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({ bookId, position: i + 1, readyUntil: i === 0 ? b.readyUntil : null });
        }
      }
      return { ok: true, loans, owed: c.m.owed, holds };
    },
  };
}
