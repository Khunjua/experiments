export function createLibrary() {
  const LOAN_DAYS = 21;
  const MAX_RENEWALS = 2;
  const FINE_PER_DAY = 25;
  const FINE_CAP = 1000;
  const BORROW_BLOCK_OWED = 1000;
  const PICKUP_DAYS = 3;

  const books = new Map();   // bookId -> { loan: {memberId,dueDate,renewals}|null, queue: [memberId], readyUntil: string|null }
  const members = new Map(); // memberId -> { owed }

  const valid = (d) => {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const t = Date.parse(d + 'T00:00:00Z');
    return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
  };
  const toDay = (d) => Math.round(Date.parse(d + 'T00:00:00Z') / 86400000);
  const addDays = (d, n) => new Date((toDay(d) + n) * 86400000).toISOString().slice(0, 10);
  const fail = (reason) => ({ ok: false, reason });

  function advance(date) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && b.readyUntil < date) {
        b.queue.shift();
        if (b.queue.length > 0) b.readyUntil = addDays(b.readyUntil, PICKUP_DAYS);
        else b.readyUntil = null;
      }
    }
  }

  function overdueLoans(memberId, date) {
    for (const b of books.values()) {
      if (b.loan && b.loan.memberId === memberId && b.loan.dueDate < date) return true;
    }
    return false;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
      if (overdueLoans(memberId, date)) return fail('overdue');
      if (b.queue.length > 0) {
        if (b.queue[0] !== memberId) return fail('reserved');
        b.queue.shift();
        b.readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('no loan');
      const late = Math.max(0, toDay(date) - toDay(b.loan.dueDate));
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      b.loan = null;
      if (b.queue.length > 0) b.readyUntil = addDays(date, PICKUP_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('no loan');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (b.queue.length > 0) return fail('held');
      if (b.loan.dueDate < date) return fail('overdue');
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (!b.loan && b.queue.length === 0) return fail('available');
      if (b.queue.includes(memberId)) return fail('duplicate');
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (!valid(date)) return fail('date');
      advance(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (!valid(date)) return fail('date');
      advance(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      const loans = [], holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: b.loan.dueDate });
        const i = b.queue.indexOf(memberId);
        if (i >= 0) holds.push({ bookId, position: i + 1, readyUntil: i === 0 ? b.readyUntil : null });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
