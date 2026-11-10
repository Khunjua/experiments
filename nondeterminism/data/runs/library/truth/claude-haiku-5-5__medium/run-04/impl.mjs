const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const LATE_FREE_DAYS = 2;
const LATE_FEE_PER_DAY = 25;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_GRACE_DAYS = 3;

function toDayNumber(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function fromDayNumber(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  return fromDayNumber(toDayNumber(dateStr) + n);
}

function daysBetween(from, to) {
  return toDayNumber(to) - toDayNumber(from);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, queue: [memberId...], readyUntil: string | null }
  const books = new Map();
  // memberId -> { owed: number, loans: Set<bookId> }
  const members = new Map();

  // Applies expired set-asides up to and including the given date.
  function settle(date) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && book.readyUntil < date) {
        book.queue.shift();
        if (book.queue.length === 0) {
          book.readyUntil = null;
        } else {
          book.readyUntil = addDays(book.readyUntil, HOLD_GRACE_DAYS);
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.loans.size >= MAX_LOANS) return { ok: false };
      if (m.owed >= BORROW_BLOCK_OWED) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.readyUntil !== null) {
        if (b.queue[0] !== memberId) return { ok: false };
        b.queue.shift();
        b.readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }
      const lateDays = Math.max(0, daysBetween(b.loan.dueDate, date));
      let fine = 0;
      if (lateDays > LATE_FREE_DAYS) {
        fine = Math.min(lateDays * LATE_FEE_PER_DAY, FINE_CAP);
      }
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.queue.length > 0) {
        b.readyUntil = addDays(date, HOLD_GRACE_DAYS);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      settle(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !b.loan) return { ok: false };
      if (b.loan.memberId !== memberId) return { ok: false };
      if (date > b.loan.dueDate) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
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
      const isFreeOnShelf = !b.loan && b.queue.length === 0;
      if (isFreeOnShelf) return { ok: false };
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      settle(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      settle(date);
      const m = members.get(memberId);
      const loans = [];
      if (m) {
        for (const bookId of m.loans) {
          loans.push({ bookId, dueDate: books.get(bookId).loan.dueDate });
        }
      }
      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.indexOf(memberId);
        if (idx >= 0) {
          const readyUntil = idx === 0 && b.readyUntil !== null ? b.readyUntil : null;
          holds.push({ bookId, position: idx + 1, readyUntil });
        }
      }
      return { loans, owed: m ? m.owed : 0, holds };
    },
  };
}
