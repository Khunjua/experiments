const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const OWED_BLOCK_CENTS = 1000;
const LATE_FREE_DAYS = 2;
const LATE_DAY_CENTS = 25;
const FINE_CAP_CENTS = 500;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 3;

function addDays(date, n) {
  const ms = Date.parse(date + 'T00:00:00Z') + n * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// Whole days from b to a (a - b).
function daysBetween(a, b) {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}

export function createLibrary() {
  // book: { loanedTo: memberId|null, queue: [memberId], setAsideUntil: date|null }
  // When setAsideUntil is not null, queue[0] is the member the book is set aside for.
  const books = new Map();
  // member: { owed: cents, loans: Map(bookId -> { dueDate, renewals }) }
  const members = new Map();

  // Apply expirations of set-aside books up to the given date.
  function advance(date) {
    for (const book of books.values()) {
      while (book.setAsideUntil !== null && date > book.setAsideUntil) {
        const prev = book.setAsideUntil;
        book.queue.shift();
        book.setAsideUntil = book.queue.length > 0 ? addDays(prev, PICKUP_DAYS) : null;
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loanedTo: null, queue: [], setAsideUntil: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0, loans: new Map() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      advance(date);
      if (m.owed >= OWED_BLOCK_CENTS) return { ok: false };
      if (m.loans.size >= MAX_LOANS) return { ok: false };
      if (b.loanedTo !== null) return { ok: false };
      if (b.setAsideUntil !== null) {
        if (b.queue[0] !== memberId) return { ok: false };
        // Borrowing the set-aside book ends this member's hold.
        b.queue.shift();
        b.setAsideUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loanedTo = memberId;
      m.loans.set(bookId, { dueDate, renewals: 0 });
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false, fine: 0 };
      advance(date);
      const loan = m.loans.get(bookId);
      if (!loan || b.loanedTo !== memberId) return { ok: false, fine: 0 };

      const late = daysBetween(date, loan.dueDate);
      let fine = 0;
      if (late > LATE_FREE_DAYS) {
        fine = Math.min(late * LATE_DAY_CENTS, FINE_CAP_CENTS);
      }

      m.loans.delete(bookId);
      m.owed += fine;
      b.loanedTo = null;
      if (b.queue.length > 0) {
        b.setAsideUntil = addDays(date, PICKUP_DAYS);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      advance(date);
      const loan = m.loans.get(bookId);
      if (!loan || b.loanedTo !== memberId) return { ok: false };
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (date > loan.dueDate) return { ok: false };
      loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      advance(date);
      if (b.loanedTo === null && b.setAsideUntil === null) return { ok: false };
      if (m.loans.has(bookId)) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      const m = members.get(memberId);
      if (!m) return { ok: false, owed: 0 };
      advance(date);
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false, owed: m.owed };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      advance(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };

      const loans = [];
      for (const [bookId, loan] of m.loans) {
        loans.push({ bookId, dueDate: loan.dueDate });
      }

      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.indexOf(memberId);
        if (idx === -1) continue;
        const readyUntil = idx === 0 && b.setAsideUntil !== null ? b.setAsideUntil : null;
        holds.push({ bookId, position: idx + 1, readyUntil });
      }

      return { loans, owed: m.owed, holds };
    },
  };
}
