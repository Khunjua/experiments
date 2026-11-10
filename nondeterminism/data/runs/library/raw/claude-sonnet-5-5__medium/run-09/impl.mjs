const DAY = 86400000;
const toDays = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return t / DAY;
};
const fromDays = (n) => new Date(n * DAY).toISOString().slice(0, 10);

const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 7;

export function createLibrary() {
  const books = new Map(); // bookId -> { loan: {memberId, due, renewals}|null, queue: [memberId], readyUntil: number|null }
  const members = new Map(); // memberId -> { owed, loans: [bookId] }
  const fail = (reason) => ({ ok: false, reason });

  function advance(d) {
    for (const b of books.values()) {
      while (!b.loan && b.queue.length && b.readyUntil !== null && b.readyUntil < d) {
        const expired = b.readyUntil;
        b.queue.shift();
        b.readyUntil = b.queue.length ? expired + PICKUP_DAYS : null;
      }
      if (!b.queue.length) b.readyUntil = null;
    }
  }

  function setAside(b, d) {
    if (b.queue.length) b.readyUntil = d + PICKUP_DAYS;
    else b.readyUntil = null;
  }

  function prep(date) {
    const d = toDays(date);
    if (d === null) return null;
    advance(d);
    return d;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const d = prep(date);
      if (d === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('out');
      if (b.queue.length) {
        if (b.queue[0] !== memberId) return fail('reserved');
        b.queue.shift();
        setAside(b, d); // next in line (if any) is handled on return
        b.readyUntil = null;
      }
      b.loan = { memberId, due: d + LOAN_DAYS, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate: fromDays(b.loan.due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const d = prep(date);
      if (d === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      const late = Math.max(0, d - b.loan.due);
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      m.loans = m.loans.filter((x) => x !== bookId);
      b.loan = null;
      setAside(b, d);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const d = prep(date);
      if (d === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (b.queue.length) return fail('held');
      if (d > b.loan.due) return fail('overdue');
      b.loan.renewals++;
      b.loan.due = d + LOAN_DAYS;
      return { ok: true, dueDate: fromDays(b.loan.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const d = prep(date);
      if (d === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan && b.loan.memberId === memberId) return fail('own');
      if (b.queue.includes(memberId)) return fail('dup');
      if (!b.loan && !b.queue.length) return fail('available');
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
      if (!m || d === null) return { ok: false, loans: [], owed: 0, holds: [] };
      const loans = m.loans.map((id) => ({ bookId: id, dueDate: fromDays(books.get(id).loan.due) }));
      const holds = [];
      for (const [id, b] of books) {
        const i = b.queue.indexOf(memberId);
        if (i < 0) continue;
        holds.push({
          bookId: id,
          position: i + 1,
          readyUntil: i === 0 && !b.loan && b.readyUntil !== null ? fromDays(b.readyUntil) : null,
        });
      }
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
