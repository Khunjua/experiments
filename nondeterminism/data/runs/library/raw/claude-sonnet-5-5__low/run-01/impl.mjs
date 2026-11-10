export function createLibrary() {
  const LOAN_DAYS = 21, MAX_RENEWALS = 2, FINE_PER_DAY = 25, FINE_CAP = 1000;
  const HOLD_DAYS = 3, MAX_LOANS = 5, BLOCK_OWED = 1000;

  const books = new Map();   // bookId -> { loan: {memberId,dueDate,renewals}|null, queue: [{memberId, readyUntil|null}] }
  const members = new Map(); // memberId -> { owed, loans: Map(bookId -> loan) }

  const toDays = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  };
  const toStr = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const add = (s, n) => toStr(toDays(s) + n);
  const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const fail = (reason) => ({ ok: false, reason });

  function expire(date) {
    const today = toDays(date);
    for (const b of books.values()) {
      while (b.queue.length && b.queue[0].readyUntil !== null && toDays(b.queue[0].readyUntil) < today) {
        const old = b.queue.shift().readyUntil;
        if (b.queue.length) b.queue[0].readyUntil = add(old, HOLD_DAYS + 1);
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
      members.set(memberId, { owed: 0, loans: new Map() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('out');
      if (m.owed >= BLOCK_OWED) return fail('owes');
      if (m.loans.size >= MAX_LOANS) return fail('limit');
      if (b.queue.length) {
        const head = b.queue[0];
        if (head.readyUntil === null || head.memberId !== memberId) return fail('held');
        b.queue.shift();
      }
      const dueDate = add(date, LOAN_DAYS);
      const loan = { memberId, bookId, dueDate, renewals: 0 };
      b.loan = loan;
      m.loans.set(bookId, loan);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not loaned');
      const late = Math.max(0, toDays(date) - toDays(b.loan.dueDate));
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.queue.length) b.queue[0].readyUntil = add(date, HOLD_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      const loan = b.loan;
      if (!loan || loan.memberId !== memberId) return fail('not loaned');
      if (loan.renewals >= MAX_RENEWALS) return fail('max renewals');
      if (b.queue.length) return fail('held');
      if (toDays(date) > toDays(loan.dueDate)) return fail('overdue');
      loan.dueDate = add(loan.dueDate, LOAN_DAYS);
      loan.renewals++;
      return { ok: true, dueDate: loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan) return fail('available');
      if (b.loan.memberId === memberId) return fail('own loan');
      if (b.queue.some((h) => h.memberId === memberId)) return fail('duplicate');
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (!validDate(date)) return fail('date');
      expire(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (validDate(date)) expire(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [...m.loans.values()].map((l) => ({ bookId: l.bookId, dueDate: l.dueDate }));
      const holds = [];
      for (const [bookId, b] of books) {
        const i = b.queue.findIndex((h) => h.memberId === memberId);
        if (i >= 0) holds.push({ bookId, position: i + 1, readyUntil: b.queue[i].readyUntil });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
