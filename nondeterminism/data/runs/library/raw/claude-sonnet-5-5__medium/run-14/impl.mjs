export function createLibrary() {
  const LOAN_DAYS = 21;
  const MAX_RENEWALS = 2;
  const FINE_PER_DAY = 25;
  const FINE_CAP = 2000;
  const PICKUP_DAYS = 3;

  const books = new Map();   // bookId -> { loan: {memberId,dueDate,renewals}|null, queue: [{memberId, readyUntil}] }
  const members = new Map(); // memberId -> { owed }

  const valid = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
  const toDays = (d) => {
    const [y, m, dd] = d.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, dd) / 86400000);
  };
  const fromDays = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const addDays = (d, n) => fromDays(toDays(d) + n);
  const fail = (reason) => ({ ok: false, reason });

  function process(date) {
    for (const b of books.values()) {
      while (b.queue.length && b.queue[0].readyUntil !== null && date > b.queue[0].readyUntil) {
        const old = b.queue.shift().readyUntil;
        if (b.queue.length) b.queue[0].readyUntil = addDays(old, PICKUP_DAYS);
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
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      process(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('out');
      if (m.owed > 0) return fail('owes');
      if (b.queue.length) {
        if (b.queue[0].memberId !== memberId || b.queue[0].readyUntil === null) return fail('reserved');
        b.queue.shift();
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      process(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      const late = toDays(date) - toDays(b.loan.dueDate);
      const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;
      m.owed += fine;
      b.loan = null;
      if (b.queue.length) b.queue[0].readyUntil = addDays(date, PICKUP_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      process(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (date > b.loan.dueDate) return fail('overdue');
      if (b.queue.length) return fail('held');
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
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
      if (!valid(date)) return fail('date');
      process(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (valid(date)) process(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      const loans = [], holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: b.loan.dueDate });
        b.queue.forEach((h, i) => {
          if (h.memberId === memberId) holds.push({ bookId, position: i + 1, readyUntil: h.readyUntil });
        });
      }
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
