// Reference implementation of truth.md. Every scenario must pass against it.

const DAY = 86400000;
const toDays = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY;
const addDays = (s, n) => new Date((toDays(s) + n) * DAY).toISOString().slice(0, 10);
const no = () => ({ ok: false });

export function createLibrary() {
  const books = new Map(); // bookId -> { loan, queue, ready }
  const members = new Map(); // memberId -> { owed }

  // D17: drop holds whose pickup window has passed, passing the book down the line.
  function settle(book, date) {
    while (book.ready && toDays(date) > toDays(book.ready.until)) {
      const oldUntil = book.ready.until;
      book.queue.shift();
      book.ready = book.queue.length ? { memberId: book.queue[0], until: addDays(oldUntil, 3) } : null;
    }
  }

  const loansOf = (memberId) => [...books.values()].filter((b) => b.loan?.memberId === memberId).length;

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return no();
      books.set(bookId, { loan: null, queue: [], ready: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return no();
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return no();
      settle(b, date);
      if (b.loan) return no(); // D4
      if (b.ready && b.ready.memberId !== memberId) return no(); // D16
      if (loansOf(memberId) >= 5) return no(); // D2
      if (m.owed >= 1000) return no(); // D3
      if (b.ready) {
        b.queue.shift(); // D18
        b.ready = null;
      }
      b.loan = { memberId, dueDate: addDays(date, 21), renewals: 0 }; // D1
      return { ok: true, dueDate: b.loan.dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || b.loan?.memberId !== memberId) return no(); // D8
      const late = toDays(date) - toDays(b.loan.dueDate);
      const fine = late <= 2 ? 0 : Math.min(25 * late, 500); // D5, D6, D7
      m.owed += fine;
      b.loan = null;
      if (b.queue.length) b.ready = { memberId: b.queue[0], until: addDays(date, 3) }; // D16
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || b.loan?.memberId !== memberId) return no();
      if (toDays(date) > toDays(b.loan.dueDate)) return no(); // D12
      if (b.queue.length) return no(); // D11
      if (b.loan.renewals >= 2) return no(); // D10
      b.loan.dueDate = addDays(b.loan.dueDate, 21); // D9
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      const b = books.get(bookId);
      if (!members.has(memberId) || !b) return no();
      settle(b, date);
      if (!b.loan && !b.ready) return no(); // D13
      if (b.loan?.memberId === memberId || b.queue.includes(memberId)) return no(); // D14
      b.queue.push(memberId); // D15
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      const m = members.get(memberId);
      if (!m || !Number.isInteger(amount) || amount <= 0 || amount > m.owed) return no(); // D19
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      const m = members.get(memberId);
      if (!m) return no();
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        settle(b, date);
        if (b.loan?.memberId === memberId) loans.push({ bookId, dueDate: b.loan.dueDate });
        const i = b.queue.indexOf(memberId);
        if (i >= 0) {
          const readyUntil = b.ready?.memberId === memberId ? b.ready.until : null;
          holds.push({ bookId, position: i + 1, readyUntil });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
