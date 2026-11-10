const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const RENEWAL_DAYS = 21;
const MAX_LOANS = 5;
const MAX_RENEWALS = 2;
const BORROW_BLOCK_OWED = 1000;
const LATE_FEE_PER_DAY = 25;
const FREE_LATE_DAYS = 2;
const FINE_CAP = 500;
const HOLD_GRACE_DAYS = 3;

function dayNum(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function dayStr(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, k) {
  return dayStr(dayNum(s) + k);
}

function fineFor(daysLate) {
  if (daysLate <= FREE_LATE_DAYS) return 0;
  return Math.min(daysLate * LATE_FEE_PER_DAY, FINE_CAP);
}

export function createLibrary() {
  // bookId -> { loan, queue: [memberId...], reservedFor: null | { memberId, readyUntil } }
  const books = new Map();
  // memberId -> { loans: Map(bookId -> loan), owed: cents }
  const members = new Map();

  // Lazily expire set-aside reservations up to the given date.
  function settle(date) {
    const today = dayNum(date);
    for (const book of books.values()) {
      while (book.reservedFor && today > dayNum(book.reservedFor.readyUntil)) {
        const lapsed = book.reservedFor.readyUntil;
        book.queue.shift();
        if (book.queue.length > 0) {
          book.reservedFor = {
            memberId: book.queue[0],
            readyUntil: addDays(lapsed, HOLD_GRACE_DAYS),
          };
        } else {
          book.reservedFor = null;
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reservedFor: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { loans: new Map(), owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed >= BORROW_BLOCK_OWED) return { ok: false };
      if (m.loans.size >= MAX_LOANS) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.reservedFor && b.reservedFor.memberId !== memberId) return { ok: false };

      if (b.reservedFor) {
        // The hold ends; everyone behind moves up.
        b.queue.shift();
        b.reservedFor = null;
      }

      const dueDate = addDays(date, LOAN_DAYS);
      const loan = { bookId, memberId, borrowDate: date, dueDate, renewals: 0 };
      b.loan = loan;
      m.loans.set(bookId, loan);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }

      const late = dayNum(date) - dayNum(b.loan.dueDate);
      const fine = late > 0 ? fineFor(late) : 0;
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;

      if (b.queue.length > 0) {
        b.reservedFor = {
          memberId: b.queue[0],
          readyUntil: addDays(date, HOLD_GRACE_DAYS),
        };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };

      const loan = b.loan;
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (dayNum(date) > dayNum(loan.dueDate)) return { ok: false };

      loan.dueDate = addDays(loan.dueDate, RENEWAL_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };

      if (b.loan) {
        if (b.loan.memberId === memberId) return { ok: false };
      } else if (!b.reservedFor) {
        // Free on the shelf: holds refused.
        return { ok: false };
      }

      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      settle(date);
      const m = members.get(memberId);
      if (!m) return { ok: false, owed: 0 };
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
      for (const loan of m.loans.values()) {
        loans.push({ bookId: loan.bookId, dueDate: loan.dueDate });
      }

      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.indexOf(memberId);
        if (idx === -1) continue;
        const readyUntil =
          b.reservedFor && b.reservedFor.memberId === memberId
            ? b.reservedFor.readyUntil
            : null;
        holds.push({ bookId, position: idx + 1, readyUntil });
      }

      return { loans, owed: m.owed, holds };
    },
  };
}
