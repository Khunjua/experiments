const DAY_MS = 86400000;

function addDays(date, n) {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS);
}

export function createLibrary() {
  // bookId -> { loanBy: memberId | null, queue: [memberId], readyUntil: 'YYYY-MM-DD' | null }
  // Invariant: readyUntil !== null implies queue.length > 0 and queue[0] is the member the book is set aside for.
  // Invariant: loanBy !== null implies readyUntil === null.
  const books = new Map();
  // memberId -> { loans: Map(bookId -> { dueDate, renewals }), owed: cents }
  const members = new Map();

  // Lazily applies all reservation expirations up to and including the given date.
  function sweep(date) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && book.readyUntil < date) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = addDays(book.readyUntil, 3);
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loanBy: null, queue: [], readyUntil: null });
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
      if (m.loans.size >= 5) return { ok: false };
      if (m.owed >= 1000) return { ok: false };
      if (b.loanBy !== null) return { ok: false };
      if (b.readyUntil !== null) {
        // Set aside: only the member in position 1 may borrow it.
        if (b.queue[0] !== memberId) return { ok: false };
        b.queue.shift();
        b.readyUntil = null;
      }
      const dueDate = addDays(date, 21);
      b.loanBy = memberId;
      m.loans.set(bookId, { dueDate, renewals: 0 });
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false, fine: 0 };
      const loan = m.loans.get(bookId);
      if (!loan) return { ok: false, fine: 0 };
      const late = Math.max(0, daysBetween(loan.dueDate, date));
      const fine = late >= 3 ? Math.min(late * 25, 500) : 0;
      m.loans.delete(bookId);
      m.owed += fine;
      b.loanBy = null;
      if (b.queue.length > 0) {
        b.readyUntil = addDays(date, 3);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      const loan = m.loans.get(bookId);
      if (!loan) return { ok: false };
      if (loan.renewals >= 2) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
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
      const onLoan = b.loanBy !== null;
      const setAside = b.readyUntil !== null;
      if (!onLoan && !setAside) return { ok: false };
      if (m.loans.has(bookId)) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      sweep(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      sweep(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      for (const [bookId, loan] of m.loans) {
        loans.push({ bookId, dueDate: loan.dueDate });
      }
      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.indexOf(memberId);
        if (idx >= 0) {
          const setAsideForMember = idx === 0 && b.readyUntil !== null;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAsideForMember ? b.readyUntil : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
