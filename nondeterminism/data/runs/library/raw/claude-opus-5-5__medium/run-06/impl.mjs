const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const GRACE_DAYS = 1;
const PICKUP_DAYS = 7;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 500;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

function toDay(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function fromDay(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, queue: [{ memberId, readyUntil }] }
  const books = new Map();
  // memberId -> { owed, loans: [bookId] }
  const members = new Map();

  const fail = (reason) => ({ ok: false, reason });

  function setAsideNext(book, startDay) {
    if (book.loan) return;
    const head = book.queue[0];
    if (head && head.readyUntil === null) head.readyUntil = startDay + PICKUP_DAYS;
  }

  function processBook(book, today) {
    while (book.queue.length > 0 && !book.loan) {
      const head = book.queue[0];
      if (head.readyUntil === null) break;
      if (today <= head.readyUntil) break;
      const expired = book.queue.shift();
      if (book.queue.length > 0) {
        book.queue[0].readyUntil = expired.readyUntil + 1 + PICKUP_DAYS;
      }
    }
  }

  function processAll(today) {
    for (const book of books.values()) processBook(book, today);
  }

  function addBook({ bookId } = {}) {
    if (!validId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { loan: null, queue: [] });
    return { ok: true };
  }

  function addMember({ memberId } = {}) {
    if (!validId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0, loans: [] });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date } = {}) {
    const today = toDay(date);
    if (today === null) return fail('invalid date');
    processAll(today);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (book.loan) return fail('book is on loan');
    if (member.owed >= BORROW_BLOCK_OWED) return fail('too much owed');
    if (member.loans.length >= MAX_LOANS) return fail('too many loans');
    if (book.queue.length > 0) {
      const head = book.queue[0];
      if (head.memberId !== memberId || head.readyUntil === null) return fail('book reserved for another member');
      book.queue.shift();
    }
    const due = today + LOAN_DAYS;
    book.loan = { memberId, due, renewals: 0 };
    member.loans.push(bookId);
    return { ok: true, dueDate: fromDay(due) };
  }

  function returnBook({ memberId, bookId, date } = {}) {
    const today = toDay(date);
    if (today === null) return fail('invalid date');
    processAll(today);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
    const lateDays = today - book.loan.due;
    let fine = 0;
    if (lateDays > GRACE_DAYS) fine = Math.min(lateDays * FINE_PER_DAY, MAX_FINE_PER_LOAN);
    member.owed += fine;
    member.loans = member.loans.filter((b) => b !== bookId);
    book.loan = null;
    setAsideNext(book, today);
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date } = {}) {
    const today = toDay(date);
    if (today === null) return fail('invalid date');
    processAll(today);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    const loan = book.loan;
    if (!loan || loan.memberId !== memberId) return fail('not on loan to member');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
    if (book.queue.length > 0) return fail('book has holds');
    if (today > loan.due) return fail('loan is overdue');
    loan.due = loan.due + LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: fromDay(loan.due) };
  }

  function placeHold({ memberId, bookId, date } = {}) {
    const today = toDay(date);
    if (today === null) return fail('invalid date');
    processAll(today);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan && book.queue.length === 0) return fail('book is available');
    if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
    if (book.queue.some((h) => h.memberId === memberId)) return fail('already holding');
    book.queue.push({ memberId, readyUntil: null });
    return { ok: true, position: book.queue.length };
  }

  function payFine({ memberId, amount, date } = {}) {
    const today = toDay(date);
    if (today === null) return fail('invalid date');
    processAll(today);
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
    if (amount > member.owed) return fail('amount exceeds owed');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember({ memberId, date } = {}) {
    const today = toDay(date);
    if (today === null) return fail('invalid date');
    processAll(today);
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    const loans = member.loans.map((bookId) => ({
      bookId,
      dueDate: fromDay(books.get(bookId).loan.due),
    }));
    const holds = [];
    for (const [bookId, book] of books) {
      const idx = book.queue.findIndex((h) => h.memberId === memberId);
      if (idx === -1) continue;
      const h = book.queue[idx];
      holds.push({
        bookId,
        position: idx + 1,
        readyUntil: h.readyUntil === null ? null : fromDay(h.readyUntil),
      });
    }
    return { loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
