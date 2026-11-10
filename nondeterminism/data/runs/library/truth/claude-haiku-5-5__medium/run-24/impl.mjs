// Community library: loans, renewals, holds and fines.
// Dates are 'YYYY-MM-DD' strings treated as whole calendar days (UTC arithmetic).

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
  // bookId -> { loan: {memberId, dueDate, renewals} | null,
  //             queue: [memberId, ...]   (hold line; queue[0] is the reserved member if reserved),
  //             reserved: {memberId, readyUntil} | null }
  const books = new Map();
  // memberId -> { owed: cents }
  const members = new Map();

  // Expire set-aside windows that have passed by `date`, passing the book down the line.
  function sweep(date) {
    for (const book of books.values()) {
      while (book.reserved && date > book.reserved.readyUntil) {
        const prevUntil = book.reserved.readyUntil;
        book.queue.shift(); // drop the expired member's hold
        if (book.queue.length === 0) {
          book.reserved = null;
          break;
        }
        book.reserved = {
          memberId: book.queue[0],
          readyUntil: addDays(prevUntil, 3),
        };
      }
    }
  }

  function countLoans(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reserved: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed >= 1000) return { ok: false };
      if (b.loan) return { ok: false };
      if (countLoans(memberId) >= 5) return { ok: false };
      if (b.reserved) {
        if (b.reserved.memberId !== memberId) return { ok: false };
        // Borrowing the set-aside book ends this member's hold.
        b.queue.shift();
        b.reserved = null;
      } else if (b.queue.length > 0) {
        // Should not happen: a queued book is always set aside.
        return { ok: false };
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sweep(date);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }
      const late = daysBetween(b.loan.dueDate, date);
      const fine = late >= 3 ? Math.min(late * 25, 500) : 0;
      members.get(memberId).owed += fine;
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
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (b.loan.renewals >= 2) return { ok: false };
      if (date > b.loan.dueDate) return { ok: false };
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan === null && b.reserved === null) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
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
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
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
      return { loans, owed: m ? m.owed : 0, holds };
    },
  };
}
