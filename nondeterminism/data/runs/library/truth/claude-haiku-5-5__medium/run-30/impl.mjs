const DAY = 86400000;

function toMs(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromMs(toMs(s) + n * DAY);
}

function daysBetween(from, to) {
  return Math.round((toMs(to) - toMs(from)) / DAY);
}

export function createLibrary() {
  // bookId -> { onLoan: null | { memberId, dueDate, renewals },
  //             queue: [memberId, ...] (index 0 = position 1),
  //             reserved: null | { memberId, readyUntil } }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Drop lapsed set-asides, passing the book down the line as needed.
  function expire(date) {
    for (const book of books.values()) {
      while (book.reserved && date > book.reserved.readyUntil) {
        book.queue.shift();
        if (book.queue.length === 0) {
          book.reserved = null;
        } else {
          book.reserved = {
            memberId: book.queue[0],
            readyUntil: addDays(book.reserved.readyUntil, 3),
          };
        }
      }
    }
  }

  function loansOf(memberId) {
    const result = [];
    for (const [bookId, book] of books) {
      if (book.onLoan && book.onLoan.memberId === memberId) {
        result.push([bookId, book]);
      }
    }
    return result;
  }

  const lib = {
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
      expire(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (member.owed >= 1000) return { ok: false };
      if (loansOf(memberId).length >= 5) return { ok: false };
      if (book.onLoan) return { ok: false };
      if (book.reserved) {
        if (book.reserved.memberId !== memberId) return { ok: false };
        // Borrower's hold ends; everyone behind moves up automatically.
        book.queue.shift();
        book.reserved = null;
      }
      const dueDate = addDays(date, 21);
      book.onLoan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      expire(date);
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member || !book.onLoan || book.onLoan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }
      const late = Math.max(0, daysBetween(book.onLoan.dueDate, date));
      const fine = late >= 3 ? Math.min(late * 25, 500) : 0;
      member.owed += fine;
      book.onLoan = null;
      if (book.queue.length > 0) {
        book.reserved = { memberId: book.queue[0], readyUntil: addDays(date, 3) };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      expire(date);
      const book = books.get(bookId);
      if (!book || !book.onLoan || book.onLoan.memberId !== memberId) {
        return { ok: false };
      }
      const loan = book.onLoan;
      if (loan.renewals >= 2) return { ok: false };
      if (book.queue.length > 0) return { ok: false };
      if (date > loan.dueDate) return { ok: false };
      loan.dueDate = addDays(loan.dueDate, 21);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      expire(date);
      const book = books.get(bookId);
      if (!members.has(memberId) || !book) return { ok: false };
      if (!book.onLoan && !book.reserved) return { ok: false };
      if (book.onLoan && book.onLoan.memberId === memberId) return { ok: false };
      if (book.queue.includes(memberId)) return { ok: false };
      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date }) {
      expire(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, owed: 0 };
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false, owed: member.owed };
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date }) {
      expire(date);
      const member = members.get(memberId);
      if (!member) return { loans: [], owed: 0, holds: [] };

      const loans = loansOf(memberId).map(([bookId, book]) => ({
        bookId,
        dueDate: book.onLoan.dueDate,
      }));

      const holds = [];
      for (const [bookId, book] of books) {
        const i = book.queue.indexOf(memberId);
        if (i === -1) continue;
        const isReserved = book.reserved !== null && book.reserved.memberId === memberId;
        holds.push({
          bookId,
          position: i + 1,
          readyUntil: isReserved ? book.reserved.readyUntil : null,
        });
      }

      return { loans, owed: member.owed, holds };
    },
  };

  return lib;
}
