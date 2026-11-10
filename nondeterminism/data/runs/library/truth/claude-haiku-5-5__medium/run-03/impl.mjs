const DAY_MS = 86400000;

function toMs(date) {
  return Date.parse(date + 'T00:00:00Z');
}

function addDays(date, days) {
  return new Date(toMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, queue: [memberId], readyUntil: string | null }
  const books = new Map();
  // memberId -> { loans: Set<bookId>, owed: number }
  const members = new Map();

  // Expire set-aside books whose readyUntil is before the current date.
  function sweep(date) {
    for (const book of books.values()) {
      while (!book.loan && book.queue.length > 0 && book.readyUntil < date) {
        book.queue.shift();
        book.readyUntil = book.queue.length > 0 ? addDays(book.readyUntil, 3) : null;
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
      members.set(memberId, { loans: new Set(), owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sweep(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (book.loan) return { ok: false };

      const setAside = book.queue.length > 0;
      if (setAside && book.queue[0] !== memberId) return { ok: false };
      if (member.loans.size >= 5) return { ok: false };
      if (member.owed >= 1000) return { ok: false };

      if (setAside) {
        book.queue.shift();
        book.readyUntil = null;
      }

      const dueDate = addDays(date, 21);
      book.loan = { memberId, dueDate, renewals: 0 };
      member.loans.add(bookId);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sweep(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }

      const lateDays = Math.max(0, daysBetween(book.loan.dueDate, date));
      const fine = lateDays >= 3 ? Math.min(lateDays * 25, 500) : 0;

      member.owed += fine;
      member.loans.delete(bookId);
      book.loan = null;
      book.readyUntil = book.queue.length > 0 ? addDays(date, 3) : null;

      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false };
      }

      const loan = book.loan;
      if (loan.renewals >= 2) return { ok: false };
      if (book.queue.length > 0) return { ok: false };
      if (date > loan.dueDate) return { ok: false };

      loan.dueDate = addDays(loan.dueDate, 21);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sweep(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (book.loan && book.loan.memberId === memberId) return { ok: false };
      if (book.queue.includes(memberId)) return { ok: false };
      if (!book.loan && book.queue.length === 0) return { ok: false };

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

      const loans = [];
      for (const bookId of member.loans) {
        loans.push({ bookId, dueDate: books.get(bookId).loan.dueDate });
      }

      const holds = [];
      for (const [bookId, book] of books) {
        const index = book.queue.indexOf(memberId);
        if (index === -1) continue;
        const setAsideForMember = !book.loan && index === 0;
        holds.push({
          bookId,
          position: index + 1,
          readyUntil: setAsideForMember ? book.readyUntil : null,
        });
      }

      return { loans, owed: member.owed, holds };
    },
  };
}
