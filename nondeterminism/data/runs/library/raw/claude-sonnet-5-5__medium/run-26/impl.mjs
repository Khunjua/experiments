const DAY = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const HOLD_DAYS = 3;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;

function parse(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = Date.parse(d + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  if (new Date(t).toISOString().slice(0, 10) !== d) return null;
  return t / DAY;
}
function fmt(n) {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId,due,renewals}|null, queue: [memberId], readyUntil: number|null }
  const members = new Map(); // memberId -> { owed, loans: [bookId] }
  const fail = (reason) => ({ ok: false, reason });

  function sync(day) {
    for (const b of books.values()) {
      while (b.queue.length && b.readyUntil !== null && day > b.readyUntil) {
        b.queue.shift();
        b.readyUntil = b.queue.length ? b.readyUntil + 1 + HOLD_DAYS : null;
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
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const day = parse(date);
      if (day === null) return fail('date');
      sync(day);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.owed >= BLOCK_OWED) return fail('owes');
      if (m.loans.length >= MAX_LOANS) return fail('limit');
      for (const id of m.loans) if (books.get(id).loan.due < day) return fail('overdue');
      if (b.queue.length) {
        if (b.queue[0] !== memberId) return fail('reserved');
        b.queue.shift();
        b.readyUntil = null;
        // remaining queue (if any) will be set aside on return
      }
      const due = day + LOAN_DAYS;
      b.loan = { memberId, due, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate: fmt(due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const day = parse(date);
      if (day === null) return fail('date');
      sync(day);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('no loan');
      const late = Math.max(0, day - b.loan.due);
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      m.loans = m.loans.filter((x) => x !== bookId);
      b.loan = null;
      if (b.queue.length) b.readyUntil = day + HOLD_DAYS;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const day = parse(date);
      if (day === null) return fail('date');
      sync(day);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('no loan');
      if (b.queue.length) return fail('held');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('max renewals');
      if (day > b.loan.due) return fail('overdue');
      b.loan.renewals++;
      b.loan.due = day + LOAN_DAYS;
      return { ok: true, dueDate: fmt(b.loan.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const day = parse(date);
      if (day === null) return fail('date');
      sync(day);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.queue.length) return fail('available');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.queue.includes(memberId)) return fail('already held');
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const day = parse(date);
      if (day === null) return fail('date');
      sync(day);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const day = parse(date);
      const m = members.get(memberId);
      if (day === null || !m) return { ok: false, loans: [], owed: 0, holds: [] };
      sync(day);
      const loans = m.loans.map((id) => ({ bookId: id, dueDate: fmt(books.get(id).loan.due) }));
      const holds = [];
      for (const [id, b] of books) {
        const i = b.queue.indexOf(memberId);
        if (i < 0) continue;
        holds.push({
          bookId: id,
          position: i + 1,
          readyUntil: i === 0 && b.readyUntil !== null && !b.loan ? fmt(b.readyUntil) : null,
        });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
