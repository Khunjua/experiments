const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return Math.round(t / DAY_MS);
}

function formatDay(day) {
  const dt = new Date(day * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_PICKUP_DAYS = 3;

function fail(reason, extra) {
  return Object.assign({ ok: false, reason }, extra || {});
}

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, holds: [memberId], readyUntil: day | null }
  const books = new Map();
  // memberId -> { owed, loans: Set<bookId> }
  const members = new Map();

  function processExpiries(today) {
    for (const book of books.values()) {
      if (book.loan) continue;
      while (book.readyUntil !== null && today > book.readyUntil) {
        book.holds.shift();
        if (book.holds.length > 0) {
          book.readyUntil = book.readyUntil + HOLD_PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  function prepare(args, needBook) {
    if (!args || typeof args !== 'object') return { error: fail('invalid arguments') };
    const today = parseDate(args.date);
    if (today === null) return { error: fail('invalid date') };
    processExpiries(today);
    const member = members.get(args.memberId);
    if (!member) return { error: fail('unknown member') };
    let book = null;
    if (needBook) {
      book = books.get(args.bookId);
      if (!book) return { error: fail('unknown book') };
    }
    return { today, member, book };
  }

  function addBook(args) {
    const bookId = args && args.bookId;
    if (bookId === undefined || bookId === null) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { loan: null, holds: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    const memberId = args && args.memberId;
    if (memberId === undefined || memberId === null) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0, loans: new Set() });
    return { ok: true };
  }

  function borrow(args) {
    const p = prepare(args, true);
    if (p.error) return p.error;
    const { today, member, book } = p;
    const { memberId, bookId } = args;
    if (book.loan) return fail('book on loan');
    if (book.readyUntil !== null && book.holds[0] !== memberId) {
      return fail('book set aside for another member');
    }
    if (member.loans.size >= MAX_LOANS) return fail('loan limit reached');
    if (member.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
    if (book.readyUntil !== null) {
      book.holds.shift();
      book.readyUntil = null;
    }
    const due = today + LOAN_DAYS;
    book.loan = { memberId, due, renewals: 0 };
    member.loans.add(bookId);
    return { ok: true, dueDate: formatDay(due) };
  }

  function returnBook(args) {
    const p = prepare(args, true);
    if (p.error) return p.error;
    const { today, member, book } = p;
    const { memberId, bookId } = args;
    if (!book.loan || book.loan.memberId !== memberId) {
      return fail('not on loan to member', { fine: 0 });
    }
    const daysLate = today - book.loan.due;
    let fine = 0;
    if (daysLate > GRACE_DAYS) fine = Math.min(daysLate * FINE_PER_DAY, FINE_CAP);
    member.owed += fine;
    member.loans.delete(bookId);
    book.loan = null;
    if (book.holds.length > 0) {
      book.readyUntil = today + HOLD_PICKUP_DAYS;
    } else {
      book.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const p = prepare(args, true);
    if (p.error) return p.error;
    const { today, book } = p;
    const { memberId } = args;
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
    if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
    if (book.holds.length > 0) return fail('book has holds');
    if (today > book.loan.due) return fail('loan overdue');
    book.loan.due += LOAN_DAYS;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDay(book.loan.due) };
  }

  function placeHold(args) {
    const p = prepare(args, true);
    if (p.error) return p.error;
    const { book } = p;
    const { memberId } = args;
    if (!book.loan && book.readyUntil === null) return fail('book is on the shelf');
    if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
    if (book.holds.includes(memberId)) return fail('already holding');
    book.holds.push(memberId);
    return { ok: true, position: book.holds.length };
  }

  function payFine(args) {
    const p = prepare(args, false);
    if (p.error) return p.error;
    const { member } = p;
    const amount = args.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount)) {
      return fail('invalid amount', { owed: member.owed });
    }
    if (amount <= 0) return fail('amount must be positive', { owed: member.owed });
    if (amount > member.owed) return fail('amount exceeds owed', { owed: member.owed });
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const p = prepare(args, false);
    if (p.error) return Object.assign(p.error, { loans: [], owed: 0, holds: [] });
    const { member } = p;
    const { memberId } = args;
    const loans = [];
    for (const bookId of member.loans) {
      const book = books.get(bookId);
      loans.push({ bookId, dueDate: formatDay(book.loan.due) });
    }
    const holds = [];
    for (const [bookId, book] of books) {
      const idx = book.holds.indexOf(memberId);
      if (idx === -1) continue;
      const readyUntil =
        idx === 0 && !book.loan && book.readyUntil !== null
          ? formatDay(book.readyUntil)
          : null;
      holds.push({ bookId, position: idx + 1, readyUntil });
    }
    return { ok: true, loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
