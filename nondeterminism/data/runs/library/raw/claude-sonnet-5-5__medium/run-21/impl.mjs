const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 7;
const BORROW_BLOCK_OWED = 500;

function parse(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, dd] = d.split('-').map(Number);
  const t = Date.UTC(y, m - 1, dd);
  const o = new Date(t);
  if (o.getUTCFullYear() !== y || o.getUTCMonth() !== m - 1 || o.getUTCDate() !== dd) return null;
  return t / 86400000;
}
function fmt(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}
function addDays(d, n) {
  return fmt(parse(d) + n);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  const fail = (reason) => ({ ok: false, reason });

  function advance(date) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && b.readyUntil < date) {
        b.queue.shift();
        b.readyUntil = b.queue.length ? addDays(b.readyUntil, PICKUP_DAYS) : null;
      }
    }
  }
  function prep(date) {
    if (parse(date) === null) return false;
    advance(date);
    return true;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (!prep(date)) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('out');
      if (m.owed > BORROW_BLOCK_OWED) return fail('fines');
      if (b.queue.length) {
        if (b.queue[0] !== memberId) return fail('reserved');
        b.queue.shift();
        b.readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!prep(date)) return { ok: false, fine: 0 };
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false, fine: 0 };
      const late = parse(date) - parse(b.loan.dueDate);
      const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;
      m.owed += fine;
      b.loan = null;
      if (b.queue.length) b.readyUntil = addDays(date, PICKUP_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!prep(date)) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      if (b.queue.length) return fail('held');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (parse(date) > parse(b.loan.dueDate)) return fail('overdue');
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!prep(date)) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan) return fail('available');
      if (b.loan.memberId === memberId) return fail('own');
      if (b.queue.includes(memberId)) return fail('dup');
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (!prep(date)) return fail('date');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (!prep(date)) return { ok: false, loans: [], owed: 0, holds: [] };
      const m = members.get(memberId);
      if (!m) return { ok: false, loans: [], owed: 0, holds: [] };
      const loans = [], holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: b.loan.dueDate });
        const i = b.queue.indexOf(memberId);
        if (i >= 0) holds.push({ bookId, position: i + 1, readyUntil: i === 0 ? b.readyUntil : null });
      }
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
