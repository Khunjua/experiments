const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE_PER_LOAN = 500;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function formatDay(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isId(x) {
  return (typeof x === 'string' && x.length > 0) || (typeof x === 'number' && Number.isFinite(x));
}

export function createLibrary() {
  const books = new Map(); // bookId -> { loan: {memberId, due, renewals} | null, queue: [memberId], readyFor: memberId|null, readyUntil: day|null }
  const members = new Map(); // memberId -> { owed }
  let lastDay = null;

  const fail = (reason) => ({ ok: false, reason });

  function setAsideNext(book, startDay) {
    if (book.queue.length > 0) {
      book.readyFor = book.queue[0];
      book.readyUntil = startDay + PICKUP_DAYS;
    } else {
      book.readyFor = null;
      book.readyUntil = null;
    }
  }

  function advance(day) {
    for (const book of books.values()) {
      while (book.readyFor !== null && day > book.readyUntil) {
        const expiredUntil = book.readyUntil;
        book.queue.shift();
        setAsideNext(book, expiredUntil + 1);
      }
    }
  }

  function enter(date) {
    const day = parseDate(date);
    if (day === null) return null;
    if (lastDay !== null && day < lastDay) return null;
    lastDay = day;
    advance(day);
    return day;
  }

  function addBook({ bookId } = {}) {
    if (!isId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { loan: null, queue: [], readyFor: null, readyUntil: null });
    return { ok: true };
  }

  function addMember({ memberId } = {}) {
    if (!isId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0 });
    return { ok: true };
  }

  function loansOf(memberId) {
    const out = [];
    for (const [bookId, b] of books) if (b.loan && b.loan.memberId === memberId) out.push(bookId);
    return out;
  }

  function borrow({ memberId, bookId, date } = {}) {
    const day = enter(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown member or book');
    if (book.loan) return fail('book on loan');
    if (book.readyFor !== null && book.readyFor !== memberId) return fail('book set aside for another member');
    if (book.readyFor === null && book.queue.length > 0) return fail('book has waiting holds');
    if (member.owed >= BORROW_BLOCK_OWED) return fail('too much owed');
    if (loansOf(memberId).length >= MAX_LOANS) return fail('loan limit reached');
    if (book.readyFor === memberId) {
      book.queue.shift();
      book.readyFor = null;
      book.readyUntil = null;
    }
    const due = day + LOAN_DAYS;
    book.loan = { memberId, due, renewals: 0 };
    return { ok: true, dueDate: formatDay(due) };
  }

  function returnBook({ memberId, bookId, date } = {}) {
    const day = enter(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown member or book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
    const late = day - book.loan.due;
    let fine = 0;
    if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
    member.owed += fine;
    book.loan = null;
    setAsideNext(book, day);
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date } = {}) {
    const day = enter(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown member or book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
    if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
    if (book.queue.length > 0) return fail('others are waiting');
    if (day > book.loan.due) return fail('loan is overdue');
    book.loan.due += LOAN_DAYS;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDay(book.loan.due) };
  }

  function placeHold({ memberId, bookId, date } = {}) {
    const day = enter(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown member or book');
    if (!book.loan && book.readyFor === null) return fail('book is available');
    if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
    if (book.queue.includes(memberId)) return fail('already holding');
    book.queue.push(memberId);
    return { ok: true, position: book.queue.length };
  }

  function payFine({ memberId, amount, date } = {}) {
    const day = enter(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
    if (amount > member.owed) return fail('amount exceeds owed');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember({ memberId, date } = {}) {
    const day = enter(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    const loans = [];
    const holds = [];
    for (const [bookId, b] of books) {
      if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: formatDay(b.loan.due) });
      const idx = b.queue.indexOf(memberId);
      if (idx !== -1) {
        holds.push({
          bookId,
          position: idx + 1,
          readyUntil: b.readyFor === memberId ? formatDay(b.readyUntil) : null,
        });
      }
    }
    return { loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
