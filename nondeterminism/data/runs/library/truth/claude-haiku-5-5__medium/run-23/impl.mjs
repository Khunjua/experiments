const DAY_MS = 864e5;
const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const MAX_RENEWALS = 2;
const HOLD_GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const OWED_BLOCK = 1000;
const FREE_LATE_DAYS = 2;

function toDay(s) {
  return Math.round(Date.parse(s) / DAY_MS);
}

function addDays(s, n) {
  return new Date(Date.parse(s) + n * DAY_MS).toISOString().slice(0, 10);
}

function fineFor(dueDate, returnDate) {
  const late = toDay(returnDate) - toDay(dueDate);
  if (late <= FREE_LATE_DAYS) return 0;
  return Math.min(late * FINE_PER_DAY, FINE_CAP);
}

export function createLibrary() {
  // book: { onLoan: { memberId, dueDate, renewals } | null,
  //         queue: [memberId, ...],   // holds in line; queue[0] is the set-aside member if reserved
  //         reserved: { memberId, readyUntil } | null }
  const books = new Map();
  // member: { owed: cents }
  const members = new Map();

  // Apply set-aside expiries up to and including the given date.
  function sweep(date) {
    const today = toDay(date);
    for (const book of books.values()) {
      while (book.reserved && today > toDay(book.reserved.readyUntil)) {
        book.queue.shift();
        if (book.queue.length === 0) {
          book.reserved = null;
        } else {
          book.reserved = {
            memberId: book.queue[0],
            readyUntil: addDays(book.reserved.readyUntil, HOLD_GRACE_DAYS),
          };
        }
      }
    }
  }

  function loansOf(memberId) {
    const result = [];
    for (const [bookId, book] of books) {
      if (book.onLoan && book.onLoan.memberId === memberId) {
        result.push({ bookId, book });
      }
    }
    return result;
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { onLoan: null, queue: [], reserved: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sweep(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (member.owed >= OWED_BLOCK) return { ok: false };
      if (loansOf(memberId).length >= MAX_LOANS) return { ok: false };
      if (book.onLoan) return { ok: false };

      if (book.reserved) {
        if (book.reserved.memberId !== memberId) return { ok: false };
        // Borrowing the set-aside book ends this member's hold.
        book.queue.shift();
        book.reserved = null;
      } else if (book.queue.length > 0) {
        // Should not occur: queued books are always on loan or set aside.
        return { ok: false };
      }

      const dueDate = addDays(date, LOAN_DAYS);
      book.onLoan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sweep(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.onLoan || book.onLoan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }

      const fine = fineFor(book.onLoan.dueDate, date);
      member.owed += fine;
      book.onLoan = null;

      if (book.queue.length > 0) {
        book.reserved = {
          memberId: book.queue[0],
          readyUntil: addDays(date, HOLD_GRACE_DAYS),
        };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!members.has(memberId) || !book) return { ok: false };
      if (!book.onLoan || book.onLoan.memberId !== memberId) return { ok: false };
      if (book.onLoan.renewals >= MAX_RENEWALS) return { ok: false };
      if (book.queue.length > 0) return { ok: false };
      if (toDay(date) > toDay(book.onLoan.dueDate)) return { ok: false };

      book.onLoan.dueDate = addDays(book.onLoan.dueDate, LOAN_DAYS);
      book.onLoan.renewals += 1;
      return { ok: true, dueDate: book.onLoan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!members.has(memberId) || !book) return { ok: false };
      // Free on the shelf: not on loan and not set aside.
      if (!book.onLoan && !book.reserved) return { ok: false };
      if (book.onLoan && book.onLoan.memberId === memberId) return { ok: false };
      if (book.queue.includes(memberId)) return { ok: false };

      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date }) {
      sweep(date);
      const member = members.get(memberId);
      if (!member) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false, owed: member.owed };
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date }) {
      sweep(date);
      const member = members.get(memberId);
      if (!member) return { loans: [], owed: 0, holds: [] };

      const loans = loansOf(memberId).map(({ bookId, book }) => ({
        bookId,
        dueDate: book.onLoan.dueDate,
      }));

      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.queue.indexOf(memberId);
        if (idx === -1) continue;
        const isSetAside = book.reserved !== null && book.reserved.memberId === memberId;
        holds.push({
          bookId,
          position: idx + 1,
          readyUntil: isSetAside ? book.reserved.readyUntil : null,
        });
      }

      return { loans, owed: member.owed, holds };
    },
  };
}
