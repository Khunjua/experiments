const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const MAX_LOANS = 5;
const PICKUP_DAYS = 3;

function parse(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}
function fmt(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();   // id -> { loan, queue, readyUntil }
  const members = new Map(); // id -> { owed, loans:Set<bookId> }
  const fail = (reason) => ({ ok: false, reason });

  function process(day) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && b.readyUntil < day) {
        b.queue.shift();
        b.readyUntil = b.queue.length ? b.readyUntil + PICKUP_DAYS : null;
      }
    }
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const day = parse(date);
      if (day === null) return fail('date');
      process(day);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('out');
      if (m.owed > 0) return fail('owes');
      if (m.loans.size >= MAX_LOANS) return fail('limit');
      for (const id of m.loans) if (books.get(id).loan.due < day) return fail('overdue');
      if (b.queue.length) {
        if (b.queue[0] !== memberId) return fail('reserved');
        b.queue.shift();
        b.readyUntil = null;
      }
      const due = day + LOAN_DAYS;
      b.loan = { memberId, due, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate: fmt(due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const day = parse(date);
      if (day === null) return fail('date');
      process(day);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not loaned');
      const late = Math.max(0, day - b.loan.due);
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.queue.length) b.readyUntil = day + PICKUP_DAYS;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const day = parse(date);
      if (day === null) return fail('date');
      process(day);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not loaned');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('max renewals');
      if (b.queue.length) return fail('held');
      if (day > b.loan.due) return fail('overdue');
      b.loan.renewals++;
      b.loan.due = day + LOAN_DAYS;
      return { ok: true, dueDate: fmt(b.loan.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const day = parse(date);
      if (day === null) return fail('date');
      process(day);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && b.readyUntil === null) return fail('available');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.queue.includes(memberId)) return fail('duplicate');
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const day = parse(date);
      if (day === null) return fail('date');
      process(day);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const day = parse(date);
      if (day === null) return fail('date');
      process(day);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      const loans = [];
      for (const id of m.loans) loans.push({ bookId: id, dueDate: fmt(books.get(id).loan.due) });
      const holds = [];
      for (const [id, b] of books) {
        const i = b.queue.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId: id,
            position: i + 1,
            readyUntil: i === 0 && b.readyUntil !== null ? fmt(b.readyUntil) : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
