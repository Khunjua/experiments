const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_PICKUP_DAYS = 3;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function formatDay(dayNum) {
  return new Date(dayNum * DAY_MS).toISOString().slice(0, 10);
}

function validId(id) {
  return (typeof id === 'string' || typeof id === 'number') && id === id;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { loan: {memberId, due, renewals} | null, holds: [memberId], setAside: {memberId, until} | null }
  const books = new Map();
  // memberId -> { owed, loans: Set<bookId> }
  const members = new Map();

  function advance(day) {
    for (const book of books.values()) {
      while (book.setAside && day > book.setAside.until) {
        const oldUntil = book.setAside.until;
        book.holds.shift();
        if (book.holds.length > 0) {
          book.setAside = { memberId: book.holds[0], until: oldUntil + HOLD_PICKUP_DAYS };
        } else {
          book.setAside = null;
        }
      }
    }
  }

  function addBook({ bookId } = {}) {
    if (!validId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { loan: null, holds: [], setAside: null });
    return { ok: true };
  }

  function addMember({ memberId } = {}) {
    if (!validId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0, loans: new Set() });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date } = {}) {
    const day = parseDate(date);
    if (day === null) return fail('invalid date');
    advance(day);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (book.loan) return fail('book on loan');
    if (member.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
    if (member.loans.size >= MAX_LOANS) return fail('too many loans');
    if (book.setAside && book.setAside.memberId !== memberId) return fail('set aside for another member');
    if (book.setAside) {
      book.holds.shift();
      book.setAside = null;
    }
    const due = day + LOAN_DAYS;
    book.loan = { memberId, due, renewals: 0 };
    member.loans.add(bookId);
    return { ok: true, dueDate: formatDay(due) };
  }

  function returnBook({ memberId, bookId, date } = {}) {
    const day = parseDate(date);
    if (day === null) return fail('invalid date');
    advance(day);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
      return fail('not on loan to member');
    }
    const late = day - book.loan.due;
    let fine = 0;
    if (late > GRACE_DAYS) fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
    member.owed += fine;
    member.loans.delete(bookId);
    book.loan = null;
    if (book.holds.length > 0) {
      book.setAside = { memberId: book.holds[0], until: day + HOLD_PICKUP_DAYS };
    }
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date } = {}) {
    const day = parseDate(date);
    if (day === null) return fail('invalid date');
    advance(day);
    const book = books.get(bookId);
    if (!members.has(memberId) || !book || !book.loan || book.loan.memberId !== memberId) {
      return fail('not on loan to member');
    }
    if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (book.holds.length > 0) return fail('book has holds');
    if (day > book.loan.due) return fail('overdue');
    book.loan.due += LOAN_DAYS;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDay(book.loan.due) };
  }

  function placeHold({ memberId, bookId, date } = {}) {
    const day = parseDate(date);
    if (day === null) return fail('invalid date');
    advance(day);
    const book = books.get(bookId);
    if (!members.has(memberId)) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan && !book.setAside) return fail('book is on the shelf');
    if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
    if (book.holds.includes(memberId)) return fail('already holding');
    book.holds.push(memberId);
    return { ok: true, position: book.holds.length };
  }

  function payFine({ memberId, amount, date } = {}) {
    const day = parseDate(date);
    if (day === null) return fail('invalid date');
    advance(day);
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
    if (amount > member.owed) return fail('overpayment');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember({ memberId, date } = {}) {
    const day = parseDate(date);
    if (day === null) return { ok: false, reason: 'invalid date', loans: [], owed: 0, holds: [] };
    advance(day);
    const member = members.get(memberId);
    if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
    const loans = [];
    for (const bookId of member.loans) {
      loans.push({ bookId, dueDate: formatDay(books.get(bookId).loan.due) });
    }
    const holds = [];
    for (const [bookId, book] of books) {
      const idx = book.holds.indexOf(memberId);
      if (idx === -1) continue;
      const readyUntil =
        book.setAside && book.setAside.memberId === memberId ? formatDay(book.setAside.until) : null;
      holds.push({ bookId, position: idx + 1, readyUntil });
    }
    return { ok: true, loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
