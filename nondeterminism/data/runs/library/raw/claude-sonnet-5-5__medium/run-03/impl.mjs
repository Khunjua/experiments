const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 3;

function toDays(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return NaN;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}
function fromDays(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, queue }
  const members = new Map(); // memberId -> { owed }

  // loan: { memberId, due (days), renewals }
  // queue: [{ memberId, ready (days) | null }]
  function advance(book, today) {
    const q = book.queue;
    while (q.length && q[0].ready !== null && q[0].ready < today) {
      const expired = q.shift();
      if (q.length) q[0].ready = expired.ready + PICKUP_DAYS;
    }
  }

  function check(memberId, bookId, date) {
    const d = toDays(date);
    if (Number.isNaN(d)) return null;
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return null;
    advance(b, d);
    return { d, m, b };
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const c = check(memberId, bookId, date);
      if (!c) return { ok: false };
      const { d, b } = c;
      if (b.loan) return { ok: false };
      if (b.queue.length) {
        if (b.queue[0].memberId !== memberId) return { ok: false };
        b.queue.shift();
        if (b.queue.length && b.queue[0].ready !== null) b.queue[0].ready = null;
      }
      b.loan = { memberId, due: d + LOAN_DAYS, renewals: 0 };
      return { ok: true, dueDate: fromDays(b.loan.due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const c = check(memberId, bookId, date);
      if (!c) return { ok: false };
      const { d, m, b } = c;
      if (!b.loan || b.loan.memberId !== memberId) return { ok: false };
      const late = Math.max(0, d - b.loan.due);
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      b.loan = null;
      if (b.queue.length) b.queue[0].ready = d + PICKUP_DAYS;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const c = check(memberId, bookId, date);
      if (!c) return { ok: false };
      const { d, b } = c;
      const l = b.loan;
      if (!l || l.memberId !== memberId) return { ok: false };
      if (l.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length) return { ok: false };
      if (d > l.due) return { ok: false };
      l.renewals++;
      l.due = d + LOAN_DAYS;
      return { ok: true, dueDate: fromDays(l.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const c = check(memberId, bookId, date);
      if (!c) return { ok: false };
      const { b } = c;
      if (b.queue.some(h => h.memberId === memberId)) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (!b.loan && b.queue.length === 0) return { ok: false };
      b.queue.push({ memberId, ready: null });
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const m = members.get(memberId);
      if (!m || Number.isNaN(toDays(date))) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const d = toDays(date);
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (!Number.isNaN(d)) advance(b, d);
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: fromDays(b.loan.due) });
        }
        const i = b.queue.findIndex(h => h.memberId === memberId);
        if (i >= 0) {
          const r = b.queue[i].ready;
          holds.push({ bookId, position: i + 1, readyUntil: r === null ? null : fromDays(r) });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
