const DAY = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const BORROW_BLOCK_OWED = 1000;
const PICKUP_DAYS = 7;

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
  const books = new Map();
  const members = new Map();
  const fail = (reason) => ({ ok: false, reason });

  function advance(today) {
    for (const b of books.values()) {
      while (b.queue.length && b.queue[0].readyUntil !== null && b.queue[0].readyUntil < today) {
        const prev = b.queue.shift().readyUntil;
        if (b.queue.length) b.queue[0].readyUntil = prev + PICKUP_DAYS;
      }
    }
  }

  function ctx(memberId, bookId, date, needBook = true) {
    const today = parse(date);
    if (today === null) return null;
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || (needBook && !b)) return null;
    advance(today);
    return { today, m, b };
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid or duplicate');
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid or duplicate');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const c = ctx(memberId, bookId, date);
      if (!c) return fail('invalid');
      const { today, m, b } = c;
      if (b.loan) return fail('on loan');
      if (m.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
      if (b.queue.length) {
        if (b.queue[0].memberId !== memberId) return fail('reserved');
        b.queue.shift();
      }
      const due = today + LOAN_DAYS;
      b.loan = { memberId, due, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate: fmt(due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const c = ctx(memberId, bookId, date);
      if (!c) return fail('invalid');
      const { today, m, b } = c;
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed by member');
      const late = Math.max(0, today - b.loan.due);
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      m.loans = m.loans.filter((x) => x !== bookId);
      b.loan = null;
      if (b.queue.length) b.queue[0].readyUntil = today + PICKUP_DAYS;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const c = ctx(memberId, bookId, date);
      if (!c) return fail('invalid');
      const { today, b } = c;
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed by member');
      if (b.queue.length) return fail('holds waiting');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (today > b.loan.due) return fail('overdue');
      b.loan.renewals++;
      b.loan.due = today + LOAN_DAYS;
      return { ok: true, dueDate: fmt(b.loan.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const c = ctx(memberId, bookId, date);
      if (!c) return fail('invalid');
      const { b } = c;
      if (b.loan && b.loan.memberId === memberId) return fail('already borrowed');
      if (b.queue.some((h) => h.memberId === memberId)) return fail('already holding');
      if (!b.loan && b.queue.length === 0) return fail('book available');
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const today = parse(date);
      const m = members.get(memberId);
      if (today === null || !m) return fail('invalid');
      advance(today);
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('bad amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const today = parse(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      if (today !== null) advance(today);
      const loans = m.loans.map((id) => ({ bookId: id, dueDate: fmt(books.get(id).loan.due) }));
      const holds = [];
      for (const [id, b] of books) {
        const i = b.queue.findIndex((h) => h.memberId === memberId);
        if (i >= 0) {
          const r = b.queue[i].readyUntil;
          holds.push({ bookId: id, position: i + 1, readyUntil: r === null ? null : fmt(r) });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
