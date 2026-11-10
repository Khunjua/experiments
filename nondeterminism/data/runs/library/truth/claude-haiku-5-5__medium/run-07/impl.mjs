const DAY_MS = 86400000;

function toDay(s) {
  return Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY_MS);
}

function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, k) {
  return fromDay(toDay(s) + k);
}

export function createLibrary() {
  // book: { onLoan: null | { memberId, dueDate, renewals }, queue: [memberId...], reserve: null | { memberId, readyUntil } }
  // member: { loans: Set<bookId>, owed: number }
  const books = new Map();
  const members = new Map();

  // Drop expired set-asides lazily, cascading to the next person in line.
  function expire(date) {
    const today = toDay(date);
    for (const book of books.values()) {
      while (book.reserve && toDay(book.reserve.readyUntil) < today) {
        book.queue.shift();
        if (book.queue.length === 0) {
          book.reserve = null;
          break;
        }
        book.reserve = {
          memberId: book.queue[0],
          readyUntil: addDays(book.reserve.readyUntil, 3),
        };
      }
    }
  }

  function addBook({ bookId } = {}) {
    if (bookId == null || books.has(bookId)) return { ok: false };
    books.set(bookId, { onLoan: null, queue: [], reserve: null });
    return { ok: true };
  }

  function addMember({ memberId } = {}) {
    if (memberId == null || members.has(memberId)) return { ok: false };
    members.set(memberId, { loans: new Set(), owed: 0 });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date } = {}) {
    expire(date);
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.onLoan) return { ok: false };
    if (b.reserve && b.reserve.memberId !== memberId) return { ok: false };
    if (m.loans.size >= 5) return { ok: false };
    if (m.owed >= 1000) return { ok: false };

    if (b.reserve) {
      // Borrowing the set-aside book ends this member's hold.
      b.queue.shift();
      b.reserve = null;
    }
    const dueDate = addDays(date, 21);
    b.onLoan = { memberId, dueDate, renewals: 0 };
    m.loans.add(bookId);
    return { ok: true, dueDate };
  }

  function returnBook({ memberId, bookId, date } = {}) {
    expire(date);
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (!b.onLoan || b.onLoan.memberId !== memberId) return { ok: false };

    const late = toDay(date) - toDay(b.onLoan.dueDate);
    let fine = 0;
    if (late >= 3) {
      fine = Math.min(late * 25, 500);
    }
    m.owed += fine;
    m.loans.delete(bookId);
    b.onLoan = null;

    if (b.queue.length > 0) {
      b.reserve = { memberId: b.queue[0], readyUntil: addDays(date, 3) };
    }
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date } = {}) {
    expire(date);
    const b = books.get(bookId);
    if (!members.get(memberId) || !b) return { ok: false };
    if (!b.onLoan || b.onLoan.memberId !== memberId) return { ok: false };
    if (b.onLoan.renewals >= 2) return { ok: false };
    if (b.queue.length > 0) return { ok: false };
    if (toDay(date) > toDay(b.onLoan.dueDate)) return { ok: false };

    b.onLoan.dueDate = addDays(b.onLoan.dueDate, 21);
    b.onLoan.renewals += 1;
    return { ok: true, dueDate: b.onLoan.dueDate };
  }

  function placeHold({ memberId, bookId, date } = {}) {
    expire(date);
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (!b.onLoan && !b.reserve) return { ok: false };
    if (b.onLoan && b.onLoan.memberId === memberId) return { ok: false };
    if (b.queue.includes(memberId)) return { ok: false };

    b.queue.push(memberId);
    return { ok: true, position: b.queue.length };
  }

  function payFine({ memberId, amount, date } = {}) {
    expire(date);
    const m = members.get(memberId);
    if (!m) return { ok: false };
    if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember({ memberId, date } = {}) {
    expire(date);
    const m = members.get(memberId);
    if (!m) return { loans: [], owed: 0, holds: [] };

    const loans = [];
    for (const bookId of m.loans) {
      const b = books.get(bookId);
      loans.push({ bookId, dueDate: b.onLoan.dueDate });
    }

    const holds = [];
    for (const [bookId, b] of books) {
      const idx = b.queue.indexOf(memberId);
      if (idx >= 0) {
        const setAsideForMe = b.reserve && b.reserve.memberId === memberId;
        holds.push({
          bookId,
          position: idx + 1,
          readyUntil: setAsideForMe ? b.reserve.readyUntil : null,
        });
      }
    }

    return { loans, owed: m.owed, holds };
  }

  return {
    addBook,
    addMember,
    borrow,
    returnBook,
    renew,
    placeHold,
    payFine,
    getMember,
  };
}
