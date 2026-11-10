const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 2000;
const BLOCK_OWED = 500;
const PICKUP_DAYS = 7;

function parse(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, dd] = d.split('-').map(Number);
  const t = Date.UTC(y, m - 1, dd);
  const x = new Date(t);
  if (x.getUTCFullYear() !== y || x.getUTCMonth() !== m - 1 || x.getUTCDate() !== dd) return null;
  return t / 86400000;
}
function fmt(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}
function addDays(s, n) {
  return fmt(parse(s) + n);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  const fail = (reason) => ({ ok: false, reason });

  function advance(date) {
    for (const b of books.values()) {
      while (!b.loan && b.holds.length && b.holds[0].readyUntil !== null && b.holds[0].readyUntil < date) {
        const expired = b.holds.shift();
        if (b.holds.length) b.holds[0].readyUntil = addDays(expired.readyUntil, PICKUP_DAYS);
      }
    }
  }

  function removeHold(b, memberId) {
    const i = b.holds.findIndex((h) => h.memberId === memberId);
    if (i >= 0) b.holds.splice(i, 1);
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, holds: [] });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { loans: [], owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      advance(date);
      if (b.loan) return fail('out');
      if (m.owed >= BLOCK_OWED) return fail('fines');
      if (b.holds.length && b.holds[0].readyUntil !== null && b.holds[0].memberId !== memberId) return fail('reserved');
      removeHold(b, memberId);
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      advance(date);
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const late = parse(date) - parse(b.loan.dueDate);
      const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;
      m.owed += fine;
      m.loans = m.loans.filter((x) => x !== bookId);
      b.loan = null;
      if (b.holds.length) b.holds[0].readyUntil = addDays(date, PICKUP_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      advance(date);
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      if (b.holds.length) return fail('held');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (parse(date) > parse(b.loan.dueDate)) return fail('overdue');
      b.loan.dueDate = addDays(b.loan.dueDate, LOAN_DAYS);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      advance(date);
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.holds.some((h) => h.memberId === memberId)) return fail('duplicate');
      if (!b.loan && b.holds.length === 0) return fail('available');
      b.holds.push({ memberId, readyUntil: null });
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (parse(date) === null) return fail('date');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      advance(date);
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const m = members.get(memberId);
      if (!m) return { ok: false, loans: [], owed: 0, holds: [] };
      if (parse(date) !== null) advance(date);
      const loans = m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).loan.dueDate }));
      const holds = [];
      for (const [id, b] of books) {
        const i = b.holds.findIndex((h) => h.memberId === memberId);
        if (i >= 0) holds.push({ bookId: id, position: i + 1, readyUntil: b.holds[i].readyUntil });
      }
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
