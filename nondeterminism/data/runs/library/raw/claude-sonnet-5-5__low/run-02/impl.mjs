const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const MAX_LOANS = 5;
const BLOCK_OWED = 500;
const HOLD_DAYS = 3;

function parse(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, dd] = d.split('-').map(Number);
  const t = Date.UTC(y, m - 1, dd);
  const x = new Date(t);
  if (x.getUTCFullYear() !== y || x.getUTCMonth() !== m - 1 || x.getUTCDate() !== dd) return null;
  return Math.round(t / 86400000);
}
function fmt(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals}|null, queue: [], readyUntil: number|null }
  const members = new Map(); // memberId -> { owed, loans: Map(bookId -> loan) }

  function settle(day) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && day > b.readyUntil) {
        b.queue.shift();
        b.readyUntil = b.queue.length ? b.readyUntil + 1 + HOLD_DAYS : null;
      }
    }
  }

  const fail = (reason) => ({ ok: false, reason });

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0, loans: new Map() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const day = parse(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (day === null || !m || !b) return fail('invalid');
      settle(day);
      if (b.loan) return fail('on loan');
      if (m.loans.size >= MAX_LOANS) return fail('limit');
      if (m.owed >= BLOCK_OWED) return fail('owes');
      for (const l of m.loans.values()) if (day > l.due) return fail('overdue');
      if (b.readyUntil !== null) {
        if (b.queue[0] !== memberId) return fail('set aside');
        b.queue.shift();
        b.readyUntil = null;
      } else if (b.queue.length) {
        if (b.queue[0] !== memberId) return fail('held');
        b.queue.shift();
      }
      const loan = { bookId, memberId, due: day + LOAN_DAYS, renewals: 0 };
      b.loan = loan;
      m.loans.set(bookId, loan);
      return { ok: true, dueDate: fmt(loan.due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const day = parse(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (day === null || !m || !b) return fail('invalid');
      settle(day);
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const late = Math.max(0, day - b.loan.due);
      const fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.queue.length) b.readyUntil = day + HOLD_DAYS;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const day = parse(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (day === null || !m || !b) return fail('invalid');
      settle(day);
      const l = b.loan;
      if (!l || l.memberId !== memberId) return fail('not borrowed');
      if (l.renewals >= MAX_RENEWALS) return fail('max renewals');
      if (b.queue.length) return fail('held');
      if (day > l.due) return fail('overdue');
      l.renewals++;
      l.due += LOAN_DAYS;
      return { ok: true, dueDate: fmt(l.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const day = parse(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (day === null || !m || !b) return fail('invalid');
      settle(day);
      if (b.loan && b.loan.memberId === memberId) return fail('has it');
      if (b.queue.includes(memberId)) return fail('already held');
      if (!b.loan && b.readyUntil === null && b.queue.length === 0) return fail('available');
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const day = parse(date);
      const m = members.get(memberId);
      if (day === null || !m) return fail('invalid');
      settle(day);
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const day = parse(date);
      const m = members.get(memberId);
      if (day === null || !m) return fail('invalid');
      settle(day);
      const loans = [...m.loans.values()].map(l => ({ bookId: l.bookId, dueDate: fmt(l.due) }));
      const holds = [];
      for (const [bookId, b] of books) {
        const i = b.queue.indexOf(memberId);
        if (i < 0) continue;
        holds.push({
          bookId,
          position: i + 1,
          readyUntil: i === 0 && b.readyUntil !== null ? fmt(b.readyUntil) : null,
        });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
