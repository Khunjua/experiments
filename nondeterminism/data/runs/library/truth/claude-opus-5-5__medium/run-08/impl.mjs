const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function formatDate(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_PICKUP_DAYS = 3;

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, holds: [memberId], readyUntil: dayNum | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  const fail = (reason) => ({ ok: false, reason });

  function validId(id) {
    return id !== undefined && id !== null;
  }

  // Apply expirations of set-aside books up to and including the passage of `day`.
  function advanceBook(book, day) {
    while (book.readyUntil !== null && day > book.readyUntil) {
      book.holds.shift();
      if (book.holds.length > 0) {
        book.readyUntil = book.readyUntil + HOLD_PICKUP_DAYS;
      } else {
        book.readyUntil = null;
      }
    }
  }

  function advanceAll(day) {
    for (const book of books.values()) advanceBook(book, day);
  }

  function loanCount(memberId) {
    let c = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) c++;
    }
    return c;
  }

  function addBook(args) {
    const bookId = args && args.bookId;
    if (!validId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { loan: null, holds: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    const memberId = args && args.memberId;
    if (!validId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    const { memberId, bookId, date } = args || {};
    const day = parseDate(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    advanceAll(day);
    if (book.loan) return fail('book on loan');
    const setAside = book.readyUntil !== null;
    if (setAside && book.holds[0] !== memberId) return fail('book set aside for another member');
    if (member.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
    if (loanCount(memberId) >= MAX_LOANS) return fail('loan limit');
    if (setAside) {
      book.holds.shift();
      book.readyUntil = null;
    }
    const due = day + LOAN_DAYS;
    book.loan = { memberId, due, renewals: 0 };
    return { ok: true, dueDate: formatDate(due) };
  }

  function returnBook(args) {
    const { memberId, bookId, date } = args || {};
    const day = parseDate(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    advanceAll(day);
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
    const late = day - book.loan.due;
    let fine = 0;
    if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
    member.owed += fine;
    book.loan = null;
    if (book.holds.length > 0) {
      book.readyUntil = day + HOLD_PICKUP_DAYS;
    } else {
      book.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const { memberId, bookId, date } = args || {};
    const day = parseDate(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    advanceAll(day);
    const loan = book.loan;
    if (!loan || loan.memberId !== memberId) return fail('not on loan to member');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (book.holds.length > 0) return fail('book has holds');
    if (day > loan.due) return fail('overdue');
    loan.due += LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.due) };
  }

  function placeHold(args) {
    const { memberId, bookId, date } = args || {};
    const day = parseDate(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    advanceAll(day);
    if (!book.loan && book.readyUntil === null) return fail('book is on the shelf');
    if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
    if (book.holds.includes(memberId)) return fail('already holding');
    book.holds.push(memberId);
    return { ok: true, position: book.holds.length };
  }

  function payFine(args) {
    const { memberId, amount, date } = args || {};
    const day = parseDate(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    advanceAll(day);
    if (typeof amount !== 'number' || !Number.isInteger(amount)) return fail('invalid amount');
    if (amount <= 0) return fail('non-positive amount');
    if (amount > member.owed) return fail('overpayment');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const { memberId, date } = args || {};
    const day = parseDate(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    advanceAll(day);
    const loans = [];
    const holds = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) {
        loans.push({ bookId, dueDate: formatDate(book.loan.due) });
      }
      const idx = book.holds.indexOf(memberId);
      if (idx !== -1) {
        const readyUntil =
          idx === 0 && book.readyUntil !== null && !book.loan ? formatDate(book.readyUntil) : null;
        holds.push({ bookId, position: idx + 1, readyUntil });
      }
    }
    return { ok: true, loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
