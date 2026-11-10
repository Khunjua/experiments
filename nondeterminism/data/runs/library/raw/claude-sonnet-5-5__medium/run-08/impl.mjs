export function createLibrary() {
  const LOAN_DAYS = 21, MAX_RENEWALS = 2, FINE_PER_DAY = 25, FINE_CAP = 1000, PICKUP_DAYS = 7;
  const books = new Map();   // bookId -> { loan: {memberId,dueDate,renewals}|null, holds: [{memberId}], readyUntil: string|null }
  const members = new Map(); // memberId -> { owed }

  const valid = (d) => {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const t = Date.parse(d + 'T00:00:00Z');
    return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
  };
  const day = (d) => Date.parse(d + 'T00:00:00Z') / 86400000;
  const addDays = (d, n) => new Date((day(d) + n) * 86400000).toISOString().slice(0, 10);

  function expire(date) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && date > b.readyUntil && b.holds.length) {
        const e = b.readyUntil;
        b.holds.shift();
        b.readyUntil = b.holds.length ? addDays(e, 1 + PICKUP_DAYS) : null;
      }
      if (!b.holds.length) b.readyUntil = null;
    }
  }
  const fail = (reason) => ({ ok: false, reason });

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      expire(date);
      const b = books.get(bookId);
      if (!b || !members.has(memberId)) return fail('unknown');
      if (b.loan) return fail('out');
      if (b.holds.length) {
        if (b.holds[0].memberId !== memberId || b.readyUntil === null) return fail('held');
        b.holds.shift();
        b.readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      expire(date);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      const late = Math.max(0, day(date) - day(b.loan.dueDate));
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      members.get(memberId).owed += fine;
      b.loan = null;
      if (b.holds.length) b.readyUntil = addDays(date, PICKUP_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      expire(date);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (b.holds.length) return fail('held');
      if (date > b.loan.dueDate) return fail('overdue');
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      expire(date);
      const b = books.get(bookId);
      if (!b || !members.has(memberId)) return fail('unknown');
      if (!b.loan && !b.holds.length) return fail('available');
      if (b.loan && b.loan.memberId === memberId) return fail('own');
      if (b.holds.some((h) => h.memberId === memberId)) return fail('dup');
      b.holds.push({ memberId });
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (!valid(date)) return fail('date');
      expire(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const m = members.get(memberId);
      if (!m) return { ok: false, loans: [], owed: 0, holds: [] };
      if (valid(date)) expire(date);
      const loans = [], holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: b.loan.dueDate });
        const i = b.holds.findIndex((h) => h.memberId === memberId);
        if (i >= 0) holds.push({ bookId, position: i + 1, readyUntil: i === 0 ? b.readyUntil : null });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
