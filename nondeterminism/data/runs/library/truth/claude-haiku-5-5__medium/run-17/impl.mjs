const DAY_MS = 86400000;

function toDay(s) {
  return Date.parse(s + 'T00:00:00Z') / DAY_MS;
}

function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDay(toDay(s) + n);
}

export function createLibrary() {
  // bookId -> { loan: {memberId, dueDate, renewals} | null,
  //             queue: [memberId, ...]  (position 1 = queue[0]),
  //             reserved: {memberId, readyUntil} | null }
  const books = new Map();
  // memberId -> { loans: Set<bookId>, owed: cents }
  const members = new Map();

  // Applies expired set-asides up to and including `date`.
  function sweep(date) {
    const today = toDay(date);
    for (const book of books.values()) {
      while (book.reserved && toDay(book.reserved.readyUntil) < today) {
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
      members.set(memberId, { loans: new Set(), owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.loans.size >= 5) return { ok: false };
      if (m.owed >= 1000) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.reserved && b.reserved.memberId !== memberId) return { ok: false };

      if (b.reserved) {
        // The member collects the set-aside book: hold ends, line moves up.
        b.queue.shift();
        b.reserved = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }
      const late = Math.max(0, toDay(date) - toDay(b.loan.dueDate));
      const fine = late >= 3 ? Math.min(500, late * 25) : 0;
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.queue.length > 0) {
        b.reserved = { memberId: b.queue[0], readyUntil: addDays(date, 3) };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sweep(date);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= 2) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (toDay(date) > toDay(b.loan.dueDate)) return { ok: false };
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
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

      const loans = [];
      for (const bookId of m.loans) {
        loans.push({ bookId, dueDate: books.get(bookId).loan.dueDate });
      }

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
