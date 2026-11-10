const DAY = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const HOLD_DAYS = 7;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;

const parse = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isNaN(t) ? null : Math.round(t / DAY);
};
const fmt = (n) => new Date(n * DAY).toISOString().slice(0, 10);

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  const fail = (reason) => ({ ok: false, reason });

  // Expire uncollected set-aside holds up to day d.
  function sync(d) {
    for (const b of books.values()) {
      while (!b.loan && b.queue.length && b.ready < d) {
        b.queue.shift();
        b.ready = b.ready + 1 + HOLD_DAYS;
      }
      if (!b.queue.length) b.ready = null;
    }
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, queue: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const d = parse(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (d === null || !m || !b) return fail('invalid');
      sync(d);
      if (b.loan) return fail('on loan');
      if (m.owed >= BLOCK_OWED) return fail('owes too much');
      let count = 0;
      for (const x of books.values()) if (x.loan && x.loan.memberId === memberId) count++;
      if (count >= MAX_LOANS) return fail('limit');
      if (b.queue.length) {
        if (b.queue[0] !== memberId) return fail('held for another');
        b.queue.shift();
        b.ready = null;
        if (b.queue.length === 0) b.ready = null;
      }
      b.loan = { memberId, due: d + LOAN_DAYS, renewals: 0 };
      return { ok: true, dueDate: fmt(b.loan.due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const d = parse(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (d === null || !m || !b) return fail('invalid');
      sync(d);
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const late = Math.max(0, d - b.loan.due);
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      b.loan = null;
      b.ready = b.queue.length ? d + HOLD_DAYS : null;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const d = parse(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (d === null || !m || !b) return fail('invalid');
      sync(d);
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('max renewals');
      if (b.queue.length) return fail('others waiting');
      if (d > b.loan.due) return fail('overdue');
      b.loan.renewals++;
      b.loan.due = d + LOAN_DAYS;
      return { ok: true, dueDate: fmt(b.loan.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const d = parse(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (d === null || !m || !b) return fail('invalid');
      sync(d);
      if (b.loan && b.loan.memberId === memberId) return fail('already borrowed');
      if (b.queue.includes(memberId)) return fail('already held');
      if (!b.loan && !b.queue.length) return fail('available');
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const d = parse(date);
      const m = members.get(memberId);
      if (d === null || !m) return fail('invalid');
      sync(d);
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('bad amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const d = parse(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      if (d !== null) sync(d);
      const loans = [], holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: fmt(b.loan.due) });
        const i = b.queue.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: i === 0 && !b.loan && b.ready !== null ? fmt(b.ready) : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
