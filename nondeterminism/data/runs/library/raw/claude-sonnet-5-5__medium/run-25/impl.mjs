export function createLibrary() {
  const LOAN_DAYS = 21, MAX_RENEWALS = 2, FINE_PER_DAY = 25, FINE_CAP = 1000, HOLD_DAYS = 7;
  const books = new Map();   // bookId -> { loan: {memberId,dueDate,renewals}|null, queue: [{memberId, readyUntil}] }
  const members = new Map(); // memberId -> { owed }
  const dayNum = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
  };
  const fmt = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const fail = (reason) => ({ ok: false, reason });

  function expire(date) {
    const d = dayNum(date);
    for (const b of books.values()) {
      while (b.queue.length && b.queue[0].readyUntil !== null && d > dayNum(b.queue[0].readyUntil)) {
        const prev = dayNum(b.queue[0].readyUntil);
        b.queue.shift();
        if (b.queue.length) b.queue[0].readyUntil = fmt(prev + HOLD_DAYS);
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
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || isNaN(dayNum(date))) return fail('invalid');
      expire(date);
      if (m.owed > 0) return fail('fines owed');
      if (b.loan) return fail('out');
      if (b.queue.length) {
        if (b.queue[0].memberId !== memberId) return fail('set aside for other');
        b.queue.shift();
      }
      const dueDate = fmt(dayNum(date) + LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || isNaN(dayNum(date))) return fail('invalid');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const late = Math.max(0, dayNum(date) - dayNum(b.loan.dueDate));
      const fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      m.owed += fine;
      b.loan = null;
      expire(date);
      if (b.queue.length) b.queue[0].readyUntil = fmt(dayNum(date) + HOLD_DAYS);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || isNaN(dayNum(date))) return fail('invalid');
      expire(date);
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (b.queue.length) return fail('held');
      if (dayNum(date) > dayNum(b.loan.dueDate)) return fail('overdue');
      b.loan.renewals++;
      b.loan.dueDate = fmt(dayNum(date) + LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || isNaN(dayNum(date))) return fail('invalid');
      expire(date);
      if (!b.loan && !b.queue.length) return fail('available');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.queue.some((h) => h.memberId === memberId)) return fail('duplicate');
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const m = members.get(memberId);
      if (!m || !Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('invalid');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const m = members.get(memberId);
      if (!m) return fail('unknown member');
      if (!isNaN(dayNum(date))) expire(date);
      const loans = [], holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: b.loan.dueDate });
        const i = b.queue.findIndex((h) => h.memberId === memberId);
        if (i >= 0) holds.push({ bookId, position: i + 1, readyUntil: b.queue[i].readyUntil });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
