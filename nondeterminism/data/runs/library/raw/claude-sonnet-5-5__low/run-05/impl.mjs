const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const HOLD_PICKUP_DAYS = 3;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;

function toDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return NaN;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}
function fromDay(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}
function addDays(s, n) {
  return fromDay(toDay(s) + n);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  const no = (reason) => ({ ok: false, reason });

  function expire(date) {
    for (const b of books.values()) {
      while (b.ready && b.ready.until < date) {
        const next = b.queue[1];
        b.queue.shift();
        if (b.queue.length) b.ready = { until: addDays(b.ready.until, 1 + HOLD_PICKUP_DAYS) };
        else b.ready = null;
        if (next === undefined) break;
      }
    }
  }

  const validDate = (d) => typeof d === "string" && !Number.isNaN(toDay(d));

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return no("invalid");
      books.set(bookId, { loan: null, queue: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return no("invalid");
      members.set(memberId, { owed: 0, loans: new Map() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return no("date");
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return no("unknown");
      if (b.loan) return no("onloan");
      if (m.owed >= BLOCK_OWED) return no("owes");
      if (m.loans.size >= MAX_LOANS) return no("limit");
      if (b.queue.length) {
        if (!(b.ready && b.queue[0] === memberId)) return no("held");
        b.queue.shift();
        b.ready = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.set(bookId, b.loan);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return no("date");
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return no("noloan");
      const late = Math.max(0, toDay(date) - toDay(b.loan.dueDate));
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.queue.length) b.ready = { until: addDays(date, HOLD_PICKUP_DAYS) };
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return no("date");
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return no("noloan");
      if (b.loan.renewals >= MAX_RENEWALS) return no("max");
      if (b.queue.length) return no("held");
      if (toDay(date) > toDay(b.loan.dueDate)) return no("overdue");
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return no("date");
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return no("unknown");
      if (!b.loan && !b.ready) return no("available");
      if (b.loan && b.loan.memberId === memberId) return no("own");
      if (b.queue.includes(memberId)) return no("dup");
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (!validDate(date)) return no("date");
      expire(date);
      const m = members.get(memberId);
      if (!m) return no("unknown");
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return no("amount");
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (validDate(date)) expire(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [...m.loans].map(([bookId, l]) => ({ bookId, dueDate: l.dueDate }));
      const holds = [];
      for (const [bookId, b] of books) {
        const i = b.queue.indexOf(memberId);
        if (i < 0) continue;
        holds.push({
          bookId,
          position: i + 1,
          readyUntil: i === 0 && b.ready ? b.ready.until : null,
        });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
