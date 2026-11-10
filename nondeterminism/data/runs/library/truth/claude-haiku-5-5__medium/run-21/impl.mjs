const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const HOLD_DAYS = 3;
const MAX_LOANS = 5;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_FREE_LATE_DAYS = 2;
const FINE_CAP = 500;
const OWING_LIMIT = 1000;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDay(toDay(s) + n);
}

export function createLibrary() {
  // bookId -> { loan: {memberId, dueDate, renewals} | null,
  //             queue: [memberId, ...]  (holds in line order; queue[0] is the reserved member when reserved is set),
  //             reserved: {memberId, readyUntil} | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Apply lapsed set-asides up to the given date.
  function settle(date) {
    const today = toDay(date);
    for (const book of books.values()) {
      while (book.reserved && today > toDay(book.reserved.readyUntil)) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.reserved = {
            memberId: book.queue[0],
            readyUntil: addDays(book.reserved.readyUntil, HOLD_DAYS),
          };
        } else {
          book.reserved = null;
        }
      }
    }
  }

  function loanCount(memberId) {
    let n = 0;
    for (const b of books.values()) {
      if (b.loan && b.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reserved: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed >= OWING_LIMIT) return { ok: false };
      if (loanCount(memberId) >= MAX_LOANS) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.reserved && b.reserved.memberId !== memberId) return { ok: false };
      if (b.reserved) {
        // Hold ends; everyone behind moves up automatically via queue shift.
        b.queue.shift();
        b.reserved = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }
      const late = toDay(date) - toDay(b.loan.dueDate);
      const fine = late > FINE_FREE_LATE_DAYS
        ? Math.min(FINE_CAP, late * FINE_PER_DAY)
        : 0;
      m.owed += fine;
      b.loan = null;
      if (b.queue.length > 0) {
        b.reserved = {
          memberId: b.queue[0],
          readyUntil: addDays(date, HOLD_DAYS),
        };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      settle(date);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (toDay(date) > toDay(b.loan.dueDate)) return { ok: false };
      b.loan.dueDate = addDays(b.loan.dueDate, LOAN_DAYS);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      if (!b.loan && !b.reserved) return { ok: false };
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      settle(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false, owed: m.owed };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      settle(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
        const idx = b.queue.indexOf(memberId);
        if (idx >= 0) {
          const setAside = b.reserved && b.reserved.memberId === memberId;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAside ? b.reserved.readyUntil : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
