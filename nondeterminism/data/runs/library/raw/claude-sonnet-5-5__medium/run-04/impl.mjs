const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const HOLD_WINDOW = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDay(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return t / 86400000;
}

function fromDay(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  const fail = (reason) => ({ ok: false, reason });

  function advance(d) {
    for (const b of books.values()) {
      while (b.borrower === null && b.queue.length > 0 && b.readyUntil !== null && b.readyUntil < d) {
        b.queue.shift();
        if (b.queue.length > 0) b.readyUntil += HOLD_WINDOW + 1;
        else b.readyUntil = null;
      }
    }
  }

  function prep(date) {
    const d = toDay(date);
    if (d === null) return null;
    advance(d);
    return d;
  }

  function loanCount(memberId) {
    let n = 0;
    for (const b of books.values()) if (b.borrower === memberId) n++;
    return n;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { borrower: null, dueDate: null, renewals: 0, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const d = prep(date);
      if (d === null) return fail('date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.borrower !== null) return fail('out');
      if (b.queue.length > 0 && b.queue[0] !== memberId) return fail('held');
      if (m.owed >= BLOCK_OWED) return fail('owes');
      if (loanCount(memberId) >= MAX_LOANS) return fail('limit');
      if (b.queue[0] === memberId) b.queue.shift();
      b.readyUntil = null;
      b.borrower = memberId;
      b.dueDate = d + LOAN_DAYS;
      b.renewals = 0;
      return { ok: true, dueDate: fromDay(b.dueDate) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const d = prep(date);
      if (d === null) return fail('date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || b.borrower !== memberId) return fail('notBorrowed');
      const late = Math.max(0, d - b.dueDate);
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      b.borrower = null;
      b.dueDate = null;
      b.renewals = 0;
      if (b.queue.length > 0) b.readyUntil = d + HOLD_WINDOW;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const d = prep(date);
      if (d === null) return fail('date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || b.borrower !== memberId) return fail('notBorrowed');
      if (b.queue.length > 0) return fail('held');
      if (b.renewals >= MAX_RENEWALS) return fail('maxRenewals');
      if (d > b.dueDate) return fail('overdue');
      b.renewals++;
      b.dueDate = d + LOAN_DAYS;
      return { ok: true, dueDate: fromDay(b.dueDate) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const d = prep(date);
      if (d === null) return fail('date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.borrower === memberId) return fail('ownLoan');
      if (b.borrower === null && b.queue.length === 0) return fail('available');
      if (b.queue.includes(memberId)) return fail('duplicate');
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const d = prep(date);
      if (d === null) return fail('date');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      const d = prep(date);
      const m = members.get(memberId);
      if (!m || d === null) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.borrower === memberId) loans.push({ bookId, dueDate: fromDay(b.dueDate) });
        const i = b.queue.indexOf(memberId);
        if (i >= 0) {
          const ready = i === 0 && b.borrower === null && b.readyUntil !== null;
          holds.push({ bookId, position: i + 1, readyUntil: ready ? fromDay(b.readyUntil) : null });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
