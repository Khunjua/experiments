const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;

const toDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return NaN;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
};
const fromDay = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

export function createLibrary() {
  const books = new Map(); // id -> {loan:{memberId,due,renewals}|null, queue:[{memberId, ready:null|day}]}
  const members = new Map(); // id -> {owed}
  const fail = (reason) => ({ ok: false, reason });

  function process(date) {
    const d = toDay(date);
    if (Number.isNaN(d)) return;
    for (const b of books.values()) {
      while (!b.loan && b.queue.length && b.queue[0].ready !== null && b.queue[0].ready < d) {
        const prev = b.queue.shift().ready;
        if (b.queue.length) b.queue[0].ready = prev + PICKUP_DAYS;
      }
    }
  }

  const valid = (date) => !Number.isNaN(toDay(date));

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
      if (b.loan) return fail('on loan');
      if (m.owed > 0) return fail('owes');
      const d = toDay(date);
      let count = 0;
      for (const bk of books.values()) {
        if (bk.loan && bk.loan.memberId === memberId) {
          count++;
          if (bk.loan.due < d) return fail('overdue');
        }
      }
      if (count >= MAX_LOANS) return fail('limit');
      if (b.queue.length) {
        if (b.queue[0].memberId !== memberId) return fail('held');
        b.queue.shift();
        if (b.queue.length && b.queue[0].ready === null) { /* stays waiting */ }
      }
      const due = d + LOAN_DAYS;
      b.loan = { memberId, due, renewals: 0 };
      return { ok: true, dueDate: fromDay(due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      process(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const d = toDay(date);
      const late = Math.max(0, d - b.loan.due);
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      b.loan = null;
      if (b.queue.length) b.queue[0].ready = d + PICKUP_DAYS;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      process(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const d = toDay(date);
      if (d > b.loan.due) return fail('overdue');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('max renewals');
      if (b.queue.length) return fail('held');
      b.loan.renewals++;
      b.loan.due = d + LOAN_DAYS;
      return { ok: true, dueDate: fromDay(b.loan.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      process(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan && b.loan.memberId === memberId) return fail('has it');
      if (!b.loan && !b.queue.length) return fail('available');
      if (b.queue.some((h) => h.memberId === memberId)) return fail('duplicate');
      b.queue.push({ memberId, ready: null });
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
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [], holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: fromDay(b.loan.due) });
        const i = b.queue.findIndex((h) => h.memberId === memberId);
        if (i >= 0) {
          const r = b.queue[i].ready;
          holds.push({ bookId, position: i + 1, readyUntil: r === null ? null : fromDay(r) });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
