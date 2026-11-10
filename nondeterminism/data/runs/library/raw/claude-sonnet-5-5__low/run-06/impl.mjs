const DAY = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const HOLD_PICKUP_DAYS = 7;

function toDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return t / DAY;
}
function fromDay(n) {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, queue, ready }
  const members = new Map(); // memberId -> { owed, loans: [bookId] }
  const fail = (reason) => ({ ok: false, reason });

  function sync(day) {
    for (const b of books.values()) {
      while (b.ready && day > b.ready.until) {
        b.queue.shift();
        if (b.queue.length) b.ready = { memberId: b.queue[0], until: b.ready.until + 1 + HOLD_PICKUP_DAYS };
        else b.ready = null;
      }
    }
  }

  function prep(date) {
    const day = toDay(date);
    if (day === null) return null;
    sync(day);
    return day;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, queue: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (m.owed > 0) return fail('owes');
      if (b.loan) return fail('out');
      if (b.ready) {
        if (b.ready.memberId !== memberId) return fail('reserved');
        b.queue.shift();
        b.ready = null;
      }
      const due = day + LOAN_DAYS;
      b.loan = { memberId, due, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate: fromDay(due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      const late = day - b.loan.due;
      const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;
      m.owed += fine;
      m.loans = m.loans.filter((x) => x !== bookId);
      b.loan = null;
      if (b.queue.length) b.ready = { memberId: b.queue[0], until: day + HOLD_PICKUP_DAYS };
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (b.queue.length) return fail('held');
      if (day > b.loan.due) return fail('overdue');
      b.loan.renewals++;
      b.loan.due = day + LOAN_DAYS;
      return { ok: true, dueDate: fromDay(b.loan.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan) return fail('available');
      if (b.loan.memberId === memberId) return fail('own');
      if (b.queue.includes(memberId)) return fail('duplicate');
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('date');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const day = prep(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = m.loans.map((id) => ({ bookId: id, dueDate: fromDay(books.get(id).loan.due) }));
      const holds = [];
      for (const [id, b] of books) {
        const i = b.queue.indexOf(memberId);
        if (i < 0) continue;
        const ready = i === 0 && b.ready && b.ready.memberId === memberId;
        holds.push({ bookId: id, position: i + 1, readyUntil: ready ? fromDay(b.ready.until) : null });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
