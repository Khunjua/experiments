const DAY = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const HOLD_DAYS = 3;

function parse(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, dd] = d.split('-').map(Number);
  const t = Date.UTC(y, m - 1, dd);
  const x = new Date(t);
  if (x.getUTCFullYear() !== y || x.getUTCMonth() !== m - 1 || x.getUTCDate() !== dd) return null;
  return t;
}
function fmt(t) {
  return new Date(t).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map(); // id -> { loan: {memberId,due,renewals}|null, queue: [memberId], ready: null|number }
  const members = new Map(); // id -> { owed, loans: [bookId] }
  const fail = (reason) => ({ ok: false, reason });

  function advance(t) {
    for (const b of books.values()) {
      while (b.ready !== null && b.ready < t) {
        b.queue.shift();
        if (b.queue.length) b.ready += HOLD_DAYS * DAY;
        else b.ready = null;
      }
    }
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('bad');
      books.set(bookId, { loan: null, queue: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('bad');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const t = parse(date);
      if (t === null) return fail('date');
      advance(t);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('out');
      if (m.owed > 0) return fail('owes');
      for (const id of m.loans) if (books.get(id).loan.due < t) return fail('overdue');
      if (b.queue.length) {
        if (b.queue[0] !== memberId || b.ready === null) return fail('reserved');
        b.queue.shift();
        b.ready = null;
      }
      const due = t + LOAN_DAYS * DAY;
      b.loan = { memberId, due, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate: fmt(due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const t = parse(date);
      if (t === null) return fail('date');
      advance(t);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      const late = Math.round((t - b.loan.due) / DAY);
      let fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;
      m.owed += fine;
      b.loan = null;
      m.loans = m.loans.filter((x) => x !== bookId);
      if (b.queue.length) b.ready = t + HOLD_DAYS * DAY;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const t = parse(date);
      if (t === null) return fail('date');
      advance(t);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (b.queue.length) return fail('held');
      if (b.loan.due < t) return fail('overdue');
      b.loan.renewals++;
      b.loan.due = t + LOAN_DAYS * DAY;
      return { ok: true, dueDate: fmt(b.loan.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const t = parse(date);
      if (t === null) return fail('date');
      advance(t);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan && b.loan.memberId === memberId) return fail('own');
      if (b.queue.includes(memberId)) return fail('dup');
      if (!b.loan && b.queue.length === 0) return fail('available');
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const t = parse(date);
      if (t === null) return fail('date');
      advance(t);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const t = parse(date);
      if (t !== null) advance(t);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = m.loans.map((id) => ({ bookId: id, dueDate: fmt(books.get(id).loan.due) }));
      const holds = [];
      for (const [id, b] of books) {
        const i = b.queue.indexOf(memberId);
        if (i < 0) continue;
        holds.push({
          bookId: id,
          position: i + 1,
          readyUntil: i === 0 && b.ready !== null && !b.loan ? fmt(b.ready) : null,
        });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
