const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const DAY_CENTS = 25;
const FREE_LATE_DAYS = 2;
const FINE_CAP = 500;
const BORROW_BLOCK_OWED = 1000;
const MAX_RENEWALS = 2;
const HOLD_DAYS = 3;
const DAY_MS = 86400000;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDay(toDay(s) + n);
}

export function createLibrary() {
  // book: { loan: null | { memberId, dueDate, renewals }, queue: [memberId...], reserved: null | { memberId, readyUntil } }
  // queue[0] is the set-aside member while reserved is set.
  const books = new Map();
  // member: { owed: cents, loans: Set<bookId> }
  const members = new Map();

  // Applies lapsed set-asides up to the given date.
  function sweep(date) {
    const today = toDay(date);
    for (const book of books.values()) {
      while (book.reserved && today > toDay(book.reserved.readyUntil)) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.reserved = {
            memberId: book.queue[0],
            readyUntil: addDays(book.reserved.readyUntil, HOLD_DAYS),
          };
        } else {
          book.reserved = null;
        }
      }
    }
  }

  function addBook({ bookId }) {
    if (books.has(bookId)) return { ok: false };
    books.set(bookId, { loan: null, queue: [], reserved: null });
    return { ok: true };
  }

  function addMember({ memberId }) {
    if (members.has(memberId)) return { ok: false };
    members.set(memberId, { owed: 0, loans: new Set() });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date }) {
    sweep(date);
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b || b.loan) return { ok: false };
    if (m.loans.size >= MAX_LOANS || m.owed >= BORROW_BLOCK_OWED) return { ok: false };
    if (b.reserved && b.reserved.memberId !== memberId) return { ok: false };
    if (b.reserved) {
      // Hold ends; the rest of the line moves up automatically.
      b.queue.shift();
      b.reserved = null;
    }
    const dueDate = addDays(date, LOAN_DAYS);
    b.loan = { memberId, dueDate, renewals: 0 };
    m.loans.add(bookId);
    return { ok: true, dueDate };
  }

  function returnBook({ memberId, bookId, date }) {
    sweep(date);
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false, fine: 0 };
    const late = Math.max(0, toDay(date) - toDay(b.loan.dueDate));
    let fine = 0;
    if (late > FREE_LATE_DAYS) {
      fine = Math.min(late * DAY_CENTS, FINE_CAP);
    }
    m.owed += fine;
    m.loans.delete(bookId);
    b.loan = null;
    if (b.queue.length > 0) {
      b.reserved = { memberId: b.queue[0], readyUntil: addDays(date, HOLD_DAYS) };
    }
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date }) {
    sweep(date);
    const b = books.get(bookId);
    if (!members.has(memberId) || !b || !b.loan || b.loan.memberId !== memberId) {
      return { ok: false };
    }
    const loan = b.loan;
    if (loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (b.queue.length > 0) return { ok: false };
    if (toDay(date) > toDay(loan.dueDate)) return { ok: false };
    loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: loan.dueDate };
  }

  function placeHold({ memberId, bookId, date }) {
    sweep(date);
    const b = books.get(bookId);
    if (!members.has(memberId) || !b) return { ok: false };
    if (!b.loan && !b.reserved) return { ok: false };
    if (b.loan && b.loan.memberId === memberId) return { ok: false };
    if (b.queue.includes(memberId)) return { ok: false };
    b.queue.push(memberId);
    return { ok: true, position: b.queue.length };
  }

  function payFine({ memberId, amount, date }) {
    sweep(date);
    const m = members.get(memberId);
    if (!m) return { ok: false, owed: 0 };
    if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
      return { ok: false, owed: m.owed };
    }
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember({ memberId, date }) {
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
