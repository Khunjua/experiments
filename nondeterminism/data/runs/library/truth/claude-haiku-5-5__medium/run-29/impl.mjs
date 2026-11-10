const DAY_MS = 86400000;

function toDayNumber(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function fromDayNumber(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDayNumber(toDayNumber(s) + n);
}

// Number of days from a to b (positive when b is later than a).
function daysBetween(a, b) {
  return toDayNumber(b) - toDayNumber(a);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, queue, reserved }
  const members = new Map(); // memberId -> { loans: Set<bookId>, owed, holds: Set<bookId> }

  // loan:     null | { memberId, dueDate, renewals }
  // queue:    memberIds in hold order; queue[0] is position 1
  // reserved: null | { memberId, readyUntil } (set aside for queue[0])

  function syncBook(bookId, book, date) {
    // Drop lapsed reservations (a reservation lapses after readyUntil).
    while (book.reserved && daysBetween(book.reserved.readyUntil, date) > 0) {
      const lapsed = book.queue.shift();
      members.get(lapsed).holds.delete(bookId);
      if (book.queue.length > 0) {
        book.reserved = {
          memberId: book.queue[0],
          readyUntil: addDays(book.reserved.readyUntil, 3),
        };
      } else {
        book.reserved = null;
      }
    }
  }

  function tick(date) {
    for (const [bookId, book] of books) {
      syncBook(bookId, book, date);
    }
  }

  function releaseBook(book, date) {
    book.loan = null;
    if (book.queue.length > 0) {
      book.reserved = { memberId: book.queue[0], readyUntil: addDays(date, 3) };
    } else {
      book.reserved = null;
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reserved: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { loans: new Set(), owed: 0, holds: new Set() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      tick(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.loans.size >= 5) return { ok: false };
      if (m.owed >= 1000) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.reserved && b.reserved.memberId !== memberId) return { ok: false };

      if (b.reserved && b.reserved.memberId === memberId) {
        // Borrowing the set-aside book ends this member's hold.
        b.queue.shift();
        m.holds.delete(bookId);
        b.reserved = null;
      }

      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      tick(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }

      const late = Math.max(0, daysBetween(b.loan.dueDate, date));
      const fine = late >= 3 ? Math.min(late * 25, 500) : 0;

      m.owed += fine;
      m.loans.delete(bookId);
      releaseBook(b, date);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      tick(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= 2) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (daysBetween(b.loan.dueDate, date) > 0) return { ok: false }; // overdue

      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      tick(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      if (!b.loan && !b.reserved) return { ok: false }; // free on the shelf

      b.queue.push(memberId);
      m.holds.add(bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      tick(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (typeof amount !== 'number' || !Number.isInteger(amount)) return { ok: false };
      if (amount <= 0 || amount > m.owed) return { ok: false };

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      tick(date);
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
          b.reserved && b.reserved.memberId === memberId ? b.reserved.readyUntil : null;
        return { bookId, position, readyUntil };
      });

      return { loans, owed: m.owed, holds };
    },
  };
}
