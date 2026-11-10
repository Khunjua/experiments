const DAY = 86400000;
const toN = (s) => Math.floor(Date.parse(s + 'T00:00:00Z') / DAY);
const toS = (n) => new Date(n * DAY).toISOString().slice(0, 10);

export function createLibrary() {
  const books = new Map(); // id -> { loan: {memberId, due, renewals}|null, queue: [{memberId, readyUntil}] }
  const members = new Map(); // id -> { owed }
  const LOAN_DAYS = 21, MAX_RENEW = 2, FINE = 25, FINE_CAP = 1000, PICKUP = 7, MAX_LOANS = 5;

  function validDate(d) {
    return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(toN(d));
  }

  function settle(date) {
    const t = toN(date);
    for (const b of books.values()) {
      if (b.loan) continue;
      while (b.queue.length && b.queue[0].readyUntil !== null && b.queue[0].readyUntil < t) {
        const prev = b.queue.shift().readyUntil;
        if (b.queue.length) b.queue[0].readyUntil = prev + 1 + PICKUP;
      }
    }
  }

  const fail = (reason) => ({ ok: false, reason });

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('bad');
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('bad');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      settle(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || b.loan) return fail('unavailable');
      if (m.owed > 0) return fail('owes');
      let count = 0;
      for (const x of books.values()) if (x.loan && x.loan.memberId === memberId) count++;
      if (count >= MAX_LOANS) return fail('limit');
      if (b.queue.length) {
        if (b.queue[0].memberId !== memberId) return fail('held');
        b.queue.shift();
        if (b.queue.length) b.queue[0].readyUntil = null;
      }
      const due = toN(date) + LOAN_DAYS;
      b.loan = { memberId, due, renewals: 0 };
      return { ok: true, dueDate: toS(due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      settle(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      const t = toN(date);
      const late = Math.max(0, t - b.loan.due);
      const fine = Math.min(late * FINE, FINE_CAP);
      m.owed += fine;
      b.loan = null;
      if (b.queue.length) b.queue[0].readyUntil = t + PICKUP;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      settle(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      const t = toN(date);
      if (b.queue.length) return fail('held');
      if (b.loan.renewals >= MAX_RENEW) return fail('max');
      if (t > b.loan.due) return fail('overdue');
      b.loan.renewals++;
      b.loan.due = t + LOAN_DAYS;
      return { ok: true, dueDate: toS(b.loan.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      settle(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan && b.loan.memberId === memberId) return fail('own');
      if (!b.loan && b.queue.length === 0) return fail('available');
      if (b.queue.some((h) => h.memberId === memberId)) return fail('dup');
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (!validDate(date)) return fail('date');
      settle(date);
      const m = members.get(memberId);
      if (!m || !Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (validDate(date)) settle(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [], holds = [];
      for (const [id, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId: id, dueDate: toS(b.loan.due) });
        const i = b.queue.findIndex((h) => h.memberId === memberId);
        if (i >= 0) {
          const r = b.queue[i].readyUntil;
          holds.push({ bookId: id, position: i + 1, readyUntil: r === null ? null : toS(r) });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
