const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const HOLD_DAYS = 3;
const MAX_LOANS = 5;
const MAX_RENEWALS = 2;
const BORROW_BLOCK_OWED = 1000;
const FINE_PER_DAY = 25;
const FINE_GRACE_DAYS = 2;
const FINE_CAP = 500;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDay(toDay(s) + n);
}

function lateFine(daysLate) {
  if (daysLate <= FINE_GRACE_DAYS) return 0;
  return Math.min(daysLate * FINE_PER_DAY, FINE_CAP);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  // Bring set-aside holds up to date for the given date.
  // A set-aside hold whose readyUntil is before the date is dropped and the
  // book is set aside for the next member in line, until old readyUntil + 3.
  function advance(date) {
    const today = toDay(date);
    for (const book of books.values()) {
      while (book.reserved && today > toDay(book.reserved.readyUntil)) {
        const oldReadyUntil = book.reserved.readyUntil;
        const droppedId = book.queue.shift();
        const dropped = members.get(droppedId);
        if (dropped) dropped.holds.delete(book.id);
        if (book.queue.length > 0) {
          book.reserved = {
            memberId: book.queue[0],
            readyUntil: addDays(oldReadyUntil, HOLD_DAYS),
          };
        } else {
          book.reserved = null;
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { id: bookId, loan: null, queue: [], reserved: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, {
        id: memberId,
        owed: 0,
        loans: new Set(),
        holds: new Set(),
      });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed >= BORROW_BLOCK_OWED) return { ok: false };
      if (m.loans.size >= MAX_LOANS) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.reserved && b.reserved.memberId !== memberId) return { ok: false };

      if (b.reserved) {
        // The member's hold ends; everyone behind moves up one place.
        b.queue.shift();
        m.holds.delete(bookId);
        b.reserved = null;
      }

      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }

      const daysLate = toDay(date) - toDay(b.loan.dueDate);
      const fine = lateFine(daysLate);
      m.owed += fine;
      m.loans.delete(bookId);
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
      advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (toDay(date) > toDay(b.loan.dueDate)) return { ok: false };

      b.loan.dueDate = addDays(b.loan.dueDate, LOAN_DAYS);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
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
      m.holds.add(bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      advance(date);
      const m = members.get(memberId);
      if (!m) return { ok: false, owed: 0 };
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

      const loans = [...m.loans].map((bookId) => ({
        bookId,
        dueDate: books.get(bookId).loan.dueDate,
      }));

      const holds = [...m.holds].map((bookId) => {
        const b = books.get(bookId);
        const position = b.queue.indexOf(memberId) + 1;
        const readyUntil =
          b.reserved && b.reserved.memberId === memberId
            ? b.reserved.readyUntil
            : null;
        return { bookId, position, readyUntil };
      });

      return { loans, owed: m.owed, holds };
    },
  };
}
