const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const MAX_RENEWALS = 2;
const BORROW_OWED_LIMIT = 1000;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const FINE_FREE_DAYS = 2;
const HOLD_DAYS = 3;
const MS_PER_DAY = 86400000;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

function fromDay(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

function addDays(s, k) {
  return fromDay(toDay(s) + k);
}

function daysBetween(from, to) {
  return toDay(to) - toDay(from);
}

export function createLibrary() {
  // bookId -> { id, loan: {memberId, dueDate, renewals} | null,
  //             queue: [memberId, ...], readyUntil: string | null }
  // queue[0] is the member the book is set aside for when readyUntil !== null.
  const books = new Map();
  // memberId -> { loans: Map<bookId, loan>, owed: number, holds: Set<bookId> }
  const members = new Map();

  // Applies set-aside expirations up to and including the given date.
  function advance(date) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && date > book.readyUntil) {
        const dropped = book.queue.shift();
        members.get(dropped).holds.delete(book.id);
        if (book.queue.length === 0) {
          book.readyUntil = null;
        } else {
          book.readyUntil = addDays(book.readyUntil, HOLD_DAYS);
        }
      }
    }
  }

  function addBook({ bookId }) {
    if (books.has(bookId)) return { ok: false };
    books.set(bookId, { id: bookId, loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember({ memberId }) {
    if (members.has(memberId)) return { ok: false };
    members.set(memberId, { loans: new Map(), owed: 0, holds: new Set() });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date }) {
    advance(date);
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.loan) return { ok: false };
    if (m.loans.size >= MAX_LOANS) return { ok: false };
    if (m.owed >= BORROW_OWED_LIMIT) return { ok: false };
    if (b.readyUntil !== null) {
      if (b.queue[0] !== memberId) return { ok: false };
      b.queue.shift();
      m.holds.delete(bookId);
      b.readyUntil = null;
    }
    const dueDate = addDays(date, LOAN_DAYS);
    const loan = { memberId, dueDate, renewals: 0 };
    b.loan = loan;
    m.loans.set(bookId, loan);
    return { ok: true, dueDate };
  }

  function returnBook({ memberId, bookId, date }) {
    advance(date);
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false, fine: 0 };
    const loan = m.loans.get(bookId);
    if (!loan || b.loan !== loan) return { ok: false, fine: 0 };
    const late = Math.max(0, daysBetween(loan.dueDate, date));
    const fine = late > FINE_FREE_DAYS
      ? Math.min(late * FINE_PER_DAY, FINE_CAP)
      : 0;
    m.owed += fine;
    m.loans.delete(bookId);
    b.loan = null;
    if (b.queue.length > 0) {
      b.readyUntil = addDays(date, HOLD_DAYS);
    }
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date }) {
    advance(date);
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    const loan = m.loans.get(bookId);
    if (!loan || b.loan !== loan) return { ok: false };
    if (loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (b.queue.length > 0) return { ok: false };
    if (daysBetween(loan.dueDate, date) > 0) return { ok: false };
    loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: loan.dueDate };
  }

  function placeHold({ memberId, bookId, date }) {
    advance(date);
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (!b.loan && b.queue.length === 0) return { ok: false };
    if (b.loan && b.loan.memberId === memberId) return { ok: false };
    if (b.queue.includes(memberId)) return { ok: false };
    b.queue.push(memberId);
    m.holds.add(bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine({ memberId, amount, date }) {
    advance(date);
    const m = members.get(memberId);
    if (!m) return { ok: false, owed: 0 };
    if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
      return { ok: false, owed: m.owed };
    }
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember({ memberId, date }) {
    advance(date);
    const m = members.get(memberId);
    if (!m) return { loans: [], owed: 0, holds: [] };
    const loans = [...m.loans.entries()].map(([bookId, loan]) => ({
      bookId,
      dueDate: loan.dueDate,
    }));
    const holds = [...m.holds].map((bookId) => {
      const b = books.get(bookId);
      const position = b.queue.indexOf(memberId) + 1;
      const readyUntil =
        b.readyUntil !== null && b.queue[0] === memberId ? b.readyUntil : null;
      return { bookId, position, readyUntil };
    });
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
