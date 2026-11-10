const DAY_MS = 86400000;

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(s, n) {
  return new Date(parseDate(s) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

export function createLibrary() {
  // bookId -> { loan, queue, reserved }
  //   loan: null or { memberId, bookId, dueDate, renewals }
  //   queue: memberIds in hold order; while a book is free, queue[0] is the set-aside member
  //   reserved: null or { memberId, readyUntil }
  const books = new Map();
  // memberId -> { loans: Map<bookId, loan>, owed }
  const members = new Map();

  // Applies expirations of set-aside holds up to and including the given date.
  function sweep(date) {
    for (const book of books.values()) {
      while (book.reserved && date > book.reserved.readyUntil) {
        book.queue.shift();
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
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reserved: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { loans: new Map(), owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed >= 1000) return { ok: false };
      if (m.loans.size >= 5) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.reserved && b.reserved.memberId !== memberId) return { ok: false };

      if (b.reserved) {
        // Borrowing the set-aside book ends this member's hold; the line moves up.
        b.queue.shift();
        b.reserved = null;
      }

      const loan = {
        memberId,
        bookId,
        dueDate: addDays(date, 21),
        renewals: 0,
      };
      m.loans.set(bookId, loan);
      b.loan = loan;
      return { ok: true, dueDate: loan.dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      const loan = m && m.loans.get(bookId);
      if (!m || !b || !loan) return { ok: false, fine: 0 };

      const late = daysBetween(loan.dueDate, date);
      let fine = 0;
      if (late >= 3) {
        fine = Math.min(late * 25, 500);
      }
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;

      if (b.queue.length > 0) {
        b.reserved = {
          memberId: b.queue[0],
          readyUntil: addDays(date, 3),
        };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      const loan = m && m.loans.get(bookId);
      if (!m || !b || !loan) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (loan.renewals >= 2) return { ok: false };
      if (date > loan.dueDate) return { ok: false };

      loan.dueDate = addDays(loan.dueDate, 21);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sweep(date);
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
      sweep(date);
      const m = members.get(memberId);
      if (!m) return { ok: false, owed: 0 };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false, owed: m.owed };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      sweep(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };

      const loans = [...m.loans.values()].map((l) => ({
        bookId: l.bookId,
        dueDate: l.dueDate,
      }));

      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.indexOf(memberId);
        if (idx >= 0) {
          const setAside = b.reserved && b.reserved.memberId === memberId;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAside ? b.reserved.readyUntil : null,
          });
        }
      }

      return { loans, owed: m.owed, holds };
    },
  };
}
