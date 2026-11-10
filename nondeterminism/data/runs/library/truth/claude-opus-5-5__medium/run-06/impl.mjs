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

function formatDay(day) {
  const dt = new Date(day * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(id) {
  return id !== undefined && id !== null;
}

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, holds: [memberId], setAside: { memberId, readyUntil } | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function fail(reason) {
    return { ok: false, reason };
  }

  function advanceBook(book, today) {
    while (book.setAside && today > book.setAside.readyUntil) {
      const oldUntil = book.setAside.readyUntil;
      const idx = book.holds.indexOf(book.setAside.memberId);
      if (idx !== -1) book.holds.splice(idx, 1);
      if (book.holds.length > 0) {
        book.setAside = { memberId: book.holds[0], readyUntil: oldUntil + HOLD_PICKUP_DAYS };
      } else {
        book.setAside = null;
      }
    }
  }

  function advanceAll(today) {
    for (const book of books.values()) advanceBook(book, today);
  }

  function loanCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  function addBook(args) {
    const { bookId } = args || {};
    if (!validId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { loan: null, holds: [], setAside: null });
    return { ok: true };
  }

  function addMember(args) {
    const { memberId } = args || {};
    if (!validId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    const { memberId, bookId, date } = args || {};
    const today = parseDate(date);
    if (today === null) return fail('invalid date');
    advanceAll(today);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (member.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
    if (book.loan) return fail('book on loan');
    if (book.setAside && book.setAside.memberId !== memberId) return fail('set aside for another member');
    if (loanCount(memberId) >= MAX_LOANS) return fail('loan limit');
    if (book.setAside) {
      const idx = book.holds.indexOf(memberId);
      if (idx !== -1) book.holds.splice(idx, 1);
      book.setAside = null;
    }
    const due = today + LOAN_DAYS;
    book.loan = { memberId, due, renewals: 0 };
    return { ok: true, dueDate: formatDay(due) };
  }

  function returnBook(args) {
    const { memberId, bookId, date } = args || {};
    const today = parseDate(date);
    if (today === null) return fail('invalid date');
    advanceAll(today);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
    const daysLate = today - book.loan.due;
    let fine = 0;
    if (daysLate > GRACE_DAYS) fine = Math.min(daysLate * FINE_PER_DAY, FINE_CAP);
    member.owed += fine;
    book.loan = null;
    if (book.holds.length > 0) {
      book.setAside = { memberId: book.holds[0], readyUntil: today + HOLD_PICKUP_DAYS };
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const { memberId, bookId, date } = args || {};
    const today = parseDate(date);
    if (today === null) return fail('invalid date');
    advanceAll(today);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
    if (today > book.loan.due) return fail('overdue');
    if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (book.holds.length > 0) return fail('book has holds');
    book.loan.due += LOAN_DAYS;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDay(book.loan.due) };
  }

  function placeHold(args) {
    const { memberId, bookId, date } = args || {};
    const today = parseDate(date);
    if (today === null) return fail('invalid date');
    advanceAll(today);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan && !book.setAside) return fail('book is on the shelf');
    if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
    if (book.holds.includes(memberId)) return fail('already holding');
    book.holds.push(memberId);
    return { ok: true, position: book.holds.length };
  }

  function payFine(args) {
    const { memberId, amount, date } = args || {};
    const today = parseDate(date);
    if (today === null) return fail('invalid date');
    advanceAll(today);
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    if (typeof amount !== 'number' || !Number.isInteger(amount)) return fail('invalid amount');
    if (amount <= 0) return fail('amount must be positive');
    if (amount > member.owed) return fail('overpayment');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const { memberId, date } = args || {};
    const today = parseDate(date);
    if (today === null) return { ok: false, reason: 'invalid date', loans: [], owed: 0, holds: [] };
    advanceAll(today);
    const member = members.get(memberId);
    if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
    const loans = [];
    const holds = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) {
        loans.push({ bookId, dueDate: formatDay(book.loan.due) });
      }
      const idx = book.holds.indexOf(memberId);
      if (idx !== -1) {
        const readyUntil =
          book.setAside && book.setAside.memberId === memberId ? formatDay(book.setAside.readyUntil) : null;
        holds.push({ bookId, position: idx + 1, readyUntil });
      }
    }
    return { ok: true, loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
