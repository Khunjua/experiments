const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BLOCK_OWED_CENTS = 1000;
const FREE_LATE_DAYS = 2;
const FINE_PER_LATE_DAY = 25;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_DAYS = 3;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDay(toDay(s) + n);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null,
  //             queue: [memberId, ...],        // holds in line, index 0 = position 1
  //             reservation: { memberId, readyUntil } | null }
  const books = new Map();
  // memberId -> { loans: Set<bookId>, owed: number }
  const members = new Map();

  // Applies expirations of set-aside books up to and including the given date.
  function sweep(date) {
    const today = toDay(date);
    for (const book of books.values()) {
      while (book.reservation && toDay(book.reservation.readyUntil) < today) {
        const expiredUntil = book.reservation.readyUntil;
        book.queue.shift();
        if (book.queue.length > 0) {
          book.reservation = {
            memberId: book.queue[0],
            readyUntil: addDays(expiredUntil, HOLD_DAYS),
          };
        } else {
          book.reservation = null;
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reservation: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { loans: new Set(), owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.reservation && b.reservation.memberId !== memberId) return { ok: false };
      if (m.loans.size >= MAX_LOANS) return { ok: false };
      if (m.owed >= BLOCK_OWED_CENTS) return { ok: false };

      if (b.reservation) {
        // The reserved member is always at the head of the line.
        b.queue.shift();
        b.reservation = null;
      }

      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };

      const lateDays = Math.max(0, toDay(date) - toDay(b.loan.dueDate));
      const fine = lateDays > FREE_LATE_DAYS
        ? Math.min(lateDays * FINE_PER_LATE_DAY, FINE_CAP)
        : 0;

      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;

      if (b.queue.length > 0) {
        b.reservation = {
          memberId: b.queue[0],
          readyUntil: addDays(date, HOLD_DAYS),
        };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (toDay(date) > toDay(b.loan.dueDate)) return { ok: false };

      b.loan.dueDate = addDays(b.loan.dueDate, LOAN_DAYS);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (!b.loan && !b.reservation) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };

      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      sweep(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      sweep(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };

      const loans = [];
      for (const bookId of m.loans) {
        loans.push({ bookId, dueDate: books.get(bookId).loan.dueDate });
      }

      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.indexOf(memberId);
        if (idx >= 0) {
          const setAside = b.reservation && b.reservation.memberId === memberId;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAside ? b.reservation.readyUntil : null,
          });
        }
      }

      return { loans, owed: m.owed, holds };
    },
  };
}
