export function createLibrary() {
  const LOAN_DAYS = 21;
  const MAX_RENEWALS = 2;
  const FINE_PER_DAY = 25;
  const FINE_CAP = 1000;
  const PICKUP_DAYS = 7;

  const books = new Map();
  const members = new Map();

  const fail = (reason) => ({ ok: false, reason });

  const validDate = (d) => {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const t = Date.parse(d + 'T00:00:00Z');
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
  };
  const dayNum = (d) => Math.round(Date.parse(d + 'T00:00:00Z') / 86400000);
  const addDays = (d, n) =>
    new Date((dayNum(d) + n) * 86400000).toISOString().slice(0, 10);

  function advance(date) {
    for (const b of books.values()) {
      while (b.holds.length && b.holds[0].readyUntil !== null && b.holds[0].readyUntil < date) {
        const prev = b.holds.shift().readyUntil;
        if (b.holds.length) b.holds[0].readyUntil = addDays(prev, PICKUP_DAYS);
      }
    }
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, holds: [] });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('out');
      if (m.owed > 0) return fail('owes');
      if (b.holds.length) {
        if (b.holds[0].memberId !== memberId) return fail('held');
        b.holds.shift();
        if (b.holds.length) {
          // next in line waits; book is taken by this member
          b.holds[0].readyUntil = null;
        }
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0, seq: ++seq };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('notLoaned');
      const late = Math.max(0, dayNum(date) - dayNum(b.loan.dueDate));
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      b.loan = null;
      if (b.holds.length) b.holds[0].readyUntil = addDays(date, PICKUP_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('notLoaned');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (b.holds.length) return fail('held');
      if (date > b.loan.dueDate) return fail('overdue');
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.holds.length) return fail('available');
      if (b.loan && b.loan.memberId === memberId) return fail('ownLoan');
      if (b.holds.some((h) => h.memberId === memberId)) return fail('duplicate');
      b.holds.push({ memberId, readyUntil: null });
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (!validDate(date)) return fail('date');
      advance(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (!validDate(date)) return fail('date');
      advance(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate, seq: b.loan.seq });
        }
        const i = b.holds.findIndex((h) => h.memberId === memberId);
        if (i >= 0) holds.push({ bookId, position: i + 1, readyUntil: b.holds[i].readyUntil });
      }
      loans.sort((x, y) => x.seq - y.seq);
      return {
        loans: loans.map(({ bookId, dueDate }) => ({ bookId, dueDate })),
        owed: m.owed,
        holds,
      };
    },
  };

  var seq;
}
