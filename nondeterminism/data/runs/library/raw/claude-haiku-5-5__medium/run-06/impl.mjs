const LOAN_DAYS = 21;
const RENEW_LIMIT = 2;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const BLOCK_OWED = 1000;

const toDay = (s) =>
  Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))) / 86400000;
const toStr = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const addDays = (s, n) => toStr(toDay(s) + n);

export function createLibrary() {
  const members = new Map(); // memberId -> { owed }
  const books = new Map();   // bookId -> { loan: {memberId, dueDate, renewals} | null, queue: [{memberId, readyUntil}] }

  // Expire set-aside holds whose pickup window has passed.
  const settle = (date) => {
    for (const book of books.values()) {
      const first = book.queue[0];
      if (first && first.readyUntil !== null && toDay(date) > toDay(first.readyUntil)) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = addDays(date, PICKUP_DAYS);
        }
      }
    }
  };

  const loanCount = (memberId) => {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  };

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [] });
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
      if (!m || !b || b.loan) return { ok: false };

      const first = b.queue[0];
      const isPickup = Boolean(first && first.readyUntil !== null && first.memberId === memberId);
      if (!isPickup && b.queue.length > 0) return { ok: false };
      if (loanCount(memberId) >= MAX_LOANS || m.owed >= BLOCK_OWED) return { ok: false };

      if (isPickup) b.queue.shift();
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };

      const late = toDay(date) - toDay(b.loan.dueDate);
      const fine = Math.min(FINE_CAP, Math.max(0, late - GRACE_DAYS) * FINE_PER_DAY);
      m.owed += fine;
      b.loan = null;
      if (b.queue.length > 0) {
        b.queue[0].readyUntil = addDays(date, PICKUP_DAYS);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      settle(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false };
      }
      if (toDay(date) > toDay(b.loan.dueDate)) return { ok: false };
      if (b.loan.renewals >= RENEW_LIMIT) return { ok: false };
      if (b.queue.length > 0) return { ok: false };

      b.loan.dueDate = addDays(date, LOAN_DAYS);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      settle(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !b.loan) return { ok: false };
      if (b.loan.memberId === memberId) return { ok: false };
      if (b.queue.some((e) => e.memberId === memberId)) return { ok: false };

      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      settle(date);
      const m = members.get(memberId);
      if (!m || !Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
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
        const idx = b.queue.findIndex((e) => e.memberId === memberId);
        if (idx >= 0) {
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: b.queue[idx].readyUntil,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
