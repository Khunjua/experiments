const DAY_MS = 86400000;

function toDays(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDays(days) {
  const dt = new Date(days * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, n) {
  return fromDays(toDays(dateStr) + n);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fromDays(toDays(s)) === s;
}

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const OWED_LIMIT = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_PICKUP_DAYS = 3;

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, holds: [memberId], readyUntil: string|null }
  const books = new Map();
  // memberId -> { owed, loans: Set<bookId> }
  const members = new Map();

  const fail = (reason) => ({ ok: false, reason });

  function advance(date) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && book.readyUntil < date) {
        const oldReady = book.readyUntil;
        book.holds.shift();
        book.readyUntil = book.holds.length > 0 ? addDays(oldReady, HOLD_PICKUP_DAYS) : null;
      }
    }
  }

  function validId(id) {
    return id !== undefined && id !== null;
  }

  function addBook({ bookId } = {}) {
    if (!validId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { loan: null, holds: [], readyUntil: null });
    return { ok: true };
  }

  function addMember({ memberId } = {}) {
    if (!validId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0, loans: new Set() });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date } = {}) {
    if (!isValidDate(date)) return fail('invalid date');
    advance(date);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (book.loan) return fail('book on loan');
    if (book.readyUntil !== null && book.holds[0] !== memberId) return fail('book set aside for another member');
    if (member.loans.size >= MAX_LOANS) return fail('loan limit');
    if (member.owed >= OWED_LIMIT) return fail('owes too much');
    if (book.readyUntil !== null) {
      book.holds.shift();
      book.readyUntil = null;
    }
    const dueDate = addDays(date, LOAN_DAYS);
    book.loan = { memberId, dueDate, renewals: 0 };
    member.loans.add(bookId);
    return { ok: true, dueDate };
  }

  function returnBook({ memberId, bookId, date } = {}) {
    if (!isValidDate(date)) return fail('invalid date');
    advance(date);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
      return fail('not on loan to member');
    }
    const daysLate = toDays(date) - toDays(book.loan.dueDate);
    let fine = 0;
    if (daysLate > GRACE_DAYS) fine = Math.min(daysLate * FINE_PER_DAY, FINE_CAP);
    member.owed += fine;
    member.loans.delete(bookId);
    book.loan = null;
    if (book.holds.length > 0) {
      book.readyUntil = addDays(date, HOLD_PICKUP_DAYS);
    }
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date } = {}) {
    if (!isValidDate(date)) return fail('invalid date');
    advance(date);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
      return fail('not on loan to member');
    }
    if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (book.holds.length > 0) return fail('book has holds');
    if (date > book.loan.dueDate) return fail('overdue');
    book.loan.dueDate = addDays(book.loan.dueDate, LOAN_DAYS);
    book.loan.renewals += 1;
    return { ok: true, dueDate: book.loan.dueDate };
  }

  function placeHold({ memberId, bookId, date } = {}) {
    if (!isValidDate(date)) return fail('invalid date');
    advance(date);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan && book.readyUntil === null) return fail('book is on the shelf');
    if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
    if (book.holds.includes(memberId)) return fail('already holding');
    book.holds.push(memberId);
    return { ok: true, position: book.holds.length };
  }

  function payFine({ memberId, amount, date } = {}) {
    if (!isValidDate(date)) return fail('invalid date');
    advance(date);
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    if (typeof amount !== 'number' || !Number.isInteger(amount)) return fail('invalid amount');
    if (amount <= 0) return fail('amount must be positive');
    if (amount > member.owed) return fail('amount exceeds owed');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember({ memberId, date } = {}) {
    if (!isValidDate(date)) return fail('invalid date');
    advance(date);
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    const loans = [];
    for (const bookId of member.loans) {
      loans.push({ bookId, dueDate: books.get(bookId).loan.dueDate });
    }
    const holds = [];
    for (const [bookId, book] of books) {
      const idx = book.holds.indexOf(memberId);
      if (idx === -1) continue;
      const position = idx + 1;
      const readyUntil = position === 1 && book.readyUntil !== null ? book.readyUntil : null;
      holds.push({ bookId, position, readyUntil });
    }
    return { loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
