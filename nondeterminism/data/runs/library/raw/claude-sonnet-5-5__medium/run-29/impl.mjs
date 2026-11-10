export function createLibrary() {
  const LOAN_DAYS = 21;
  const MAX_RENEWALS = 2;
  const FINE_PER_DAY = 25;
  const FINE_CAP = 1000;
  const BLOCK_OWED = 1000;
  const PICKUP_DAYS = 7;

  const books = new Map();
  const members = new Map();

  const toDay = (s) => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
    return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
  };
  const fromDay = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const addDays = (s, n) => fromDay(toDay(s) + n);
  const validDate = (d) => !Number.isNaN(toDay(d));

  function process(date) {
    for (const b of books.values()) {
      while (b.queue.length && b.queue[0].readyUntil !== null && b.queue[0].readyUntil < date) {
        const expired = b.queue.shift();
        if (b.queue.length) b.queue[0].readyUntil = addDays(expired.readyUntil, PICKUP_DAYS);
      }
    }
  }

  const fail = (reason) => ({ ok: false, reason });

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
      if (!validDate(date)) return fail('date');
      process(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('out');
      if (m.owed >= BLOCK_OWED) return fail('owes');
      if (m.loans.some((id) => books.get(id).loan.dueDate < date)) return fail('overdue');
      if (b.queue.length) {
        if (b.queue[0].memberId !== memberId) return fail('held');
        b.queue.shift();
        if (b.queue.length && b.queue[0].readyUntil === null) {
          // should not happen; keep consistent
          b.queue[0].readyUntil = addDays(date, PICKUP_DAYS);
        }
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      process(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      const late = toDay(date) - toDay(b.loan.dueDate);
      const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;
      m.owed += fine;
      b.loan = null;
      m.loans = m.loans.filter((id) => id !== bookId);
      if (b.queue.length) b.queue[0].readyUntil = addDays(date, PICKUP_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      process(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      if (b.queue.length) return fail('held');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (date > b.loan.dueDate) return fail('overdue');
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      process(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan) return fail('available');
      if (b.loan.memberId === memberId) return fail('own');
      if (b.queue.some((h) => h.memberId === memberId)) return fail('dup');
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (!validDate(date)) return fail('date');
      process(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (validDate(date)) process(date);
      const holds = [];
      for (const [bookId, b] of books) {
        const i = b.queue.findIndex((h) => h.memberId === memberId);
        if (i >= 0) holds.push({ bookId, position: i + 1, readyUntil: b.queue[i].readyUntil });
      }
      return {
        loans: m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).loan.dueDate })),
        owed: m.owed,
        holds,
      };
    },
  };
}
