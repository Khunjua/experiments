const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const HOLD_DAYS = 7;
const BORROW_BLOCK_OWED = 1000;

const RE = /^\d{4}-\d{2}-\d{2}$/;
function parse(d) {
  if (typeof d !== 'string' || !RE.test(d)) return null;
  const [y, m, dd] = d.split('-').map(Number);
  const t = Date.UTC(y, m - 1, dd);
  const o = new Date(t);
  if (o.getUTCFullYear() !== y || o.getUTCMonth() !== m - 1 || o.getUTCDate() !== dd) return null;
  return t / 86400000;
}
function fmt(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}
function addDays(s, n) {
  return fmt(parse(s) + n);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId,dueDate,renewals}|null, queue: [{memberId, readyUntil}] }
  const members = new Map(); // memberId -> { owed, loans: [bookId] }

  const fail = (reason) => ({ ok: false, reason });

  function sync(date) {
    for (const b of books.values()) {
      while (b.queue.length && b.queue[0].readyUntil !== null && b.queue[0].readyUntil < date) {
        const prev = b.queue.shift().readyUntil;
        if (b.queue.length) b.queue[0].readyUntil = addDays(prev, 1 + HOLD_DAYS);
      }
    }
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      sync(date);
      if (b.loan) return fail('onLoan');
      if (m.owed >= BORROW_BLOCK_OWED) return fail('owes');
      if (b.queue.length) {
        if (b.queue[0].memberId !== memberId) return fail('reserved');
        b.queue.shift();
        if (b.queue.length) { /* next stays waiting until return */ }
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const today = parse(date);
      if (today === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      sync(date);
      if (!b.loan || b.loan.memberId !== memberId) return fail('notBorrowed');
      const late = Math.max(0, today - parse(b.loan.dueDate));
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      b.loan = null;
      m.loans = m.loans.filter((x) => x !== bookId);
      if (b.queue.length) b.queue[0].readyUntil = addDays(date, HOLD_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const today = parse(date);
      if (today === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      sync(date);
      if (!b.loan || b.loan.memberId !== memberId) return fail('notBorrowed');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (today > parse(b.loan.dueDate)) return fail('overdue');
      if (b.queue.length) return fail('held');
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      sync(date);
      if (!b.loan) return fail('available');
      if (b.loan.memberId === memberId) return fail('ownLoan');
      if (b.queue.some((h) => h.memberId === memberId)) return fail('duplicate');
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (parse(date) === null) return fail('date');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      sync(date);
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (parse(date) === null) return fail('date');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      sync(date);
      const loans = m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).loan.dueDate }));
      const holds = [];
      for (const [id, b] of books) {
        const i = b.queue.findIndex((h) => h.memberId === memberId);
        if (i >= 0) holds.push({ bookId: id, position: i + 1, readyUntil: b.queue[i].readyUntil });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
