const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const HOLD_WINDOW_DAYS = 3;
const MAX_LOANS = 5;
const BORROW_BLOCK_CENTS = 1000;
const LATE_FEE_CENTS = 25;
const FREE_LATE_DAYS = 2;
const FINE_CAP_CENTS = 500;
const MAX_RENEWALS = 2;

function toDay(dateStr) {
  return Math.round(Date.parse(dateStr + 'T00:00:00Z') / DAY_MS);
}

function fromDay(dayNumber) {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

export function createLibrary() {
  // bookId -> { loan: {memberId, dueDay, renewals} | null, queue: [memberId...], reserved: {memberId, until} | null }
  const books = new Map();
  // memberId -> { owed: cents, loans: Map(bookId -> loan) }
  const members = new Map();

  // Drop expired set-aside holds, passing the book to the next in line.
  function settle(today) {
    for (const book of books.values()) {
      while (book.reserved && book.reserved.until < today) {
        book.queue.shift();
        if (book.queue.length === 0) {
          book.reserved = null;
        } else {
          book.reserved = {
            memberId: book.queue[0],
            until: book.reserved.until + HOLD_WINDOW_DAYS,
          };
        }
      }
    }
  }

  function advance(dateStr) {
    const today = toDay(dateStr);
    settle(today);
    return today;
  }

  function loanOf(memberId, bookId) {
    const b = books.get(bookId);
    if (!b || !b.loan || b.loan.memberId !== memberId) return null;
    return b;
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reserved: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0, loans: new Map() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const today = advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.reserved && b.reserved.memberId !== memberId) return { ok: false };
      if (m.loans.size >= MAX_LOANS) return { ok: false };
      if (m.owed >= BORROW_BLOCK_CENTS) return { ok: false };

      if (b.reserved) {
        // Borrowing the set-aside book ends the hold; everyone behind moves up.
        b.queue.shift();
        b.reserved = null;
      }

      const loan = { memberId, dueDay: today + LOAN_DAYS, renewals: 0 };
      b.loan = loan;
      m.loans.set(bookId, loan);
      return { ok: true, dueDate: fromDay(loan.dueDay) };
    },

    returnBook({ memberId, bookId, date }) {
      const today = advance(date);
      const m = members.get(memberId);
      const b = loanOf(memberId, bookId);
      if (!m || !b) return { ok: false, fine: 0 };

      const late = Math.max(0, today - b.loan.dueDay);
      const fine = late > FREE_LATE_DAYS
        ? Math.min(FINE_CAP_CENTS, late * LATE_FEE_CENTS)
        : 0;

      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;

      if (b.queue.length > 0) {
        b.reserved = { memberId: b.queue[0], until: today + HOLD_WINDOW_DAYS };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const today = advance(date);
      const b = loanOf(memberId, bookId);
      if (!b) return { ok: false };
      const loan = b.loan;
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (today > loan.dueDay) return { ok: false };

      loan.dueDay += LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: fromDay(loan.dueDay) };
    },

    placeHold({ memberId, bookId, date }) {
      advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (!b.loan && !b.reserved) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };

      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      advance(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      advance(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };

      const loans = [...m.loans].map(([bookId, loan]) => ({
        bookId,
        dueDate: fromDay(loan.dueDay),
      }));

      const holds = [];
      for (const [bookId, b] of books) {
        const index = b.queue.indexOf(memberId);
        if (index === -1) continue;
        const setAside = b.reserved !== null && b.reserved.memberId === memberId;
        holds.push({
          bookId,
          position: index + 1,
          readyUntil: setAside ? fromDay(b.reserved.until) : null,
        });
      }

      return { loans, owed: m.owed, holds };
    },
  };
}
