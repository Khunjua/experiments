const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE_PER_LOAN = 1000;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const OWED_BLOCK_LIMIT = 1000;
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

function validId(id) {
  return typeof id === 'string' && id.length > 0;
}

const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, queue: [{ memberId, readyUntil|null }] }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();
  let lastDay = null;

  function checkDate(date) {
    const day = parseDate(date);
    if (day === null) return null;
    if (lastDay !== null && day < lastDay) return null;
    return day;
  }

  function advance(day) {
    lastDay = day;
    for (const book of books.values()) {
      while (book.queue.length > 0 && book.queue[0].readyUntil !== null && book.queue[0].readyUntil < day) {
        const expired = book.queue.shift();
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = expired.readyUntil + PICKUP_DAYS;
        }
      }
    }
  }

  function loansOf(memberId) {
    const result = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) result.push({ bookId, loan: book.loan });
    }
    return result;
  }

  function holdsOf(memberId) {
    const result = [];
    for (const [bookId, book] of books) {
      const idx = book.queue.findIndex((h) => h.memberId === memberId);
      if (idx >= 0) result.push({ bookId, position: idx + 1, readyUntil: book.queue[idx].readyUntil });
    }
    return result;
  }

  function fineFor(due, day) {
    const late = day - due;
    if (late <= GRACE_DAYS) return 0;
    return Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
  }

  function addBook({ bookId } = {}) {
    if (!validId(bookId) || books.has(bookId)) return fail('invalid or duplicate book');
    books.set(bookId, { loan: null, queue: [] });
    return { ok: true };
  }

  function addMember({ memberId } = {}) {
    if (!validId(memberId) || members.has(memberId)) return fail('invalid or duplicate member');
    members.set(memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date } = {}) {
    const day = checkDate(date);
    if (day === null) return fail('bad date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown member or book');
    advance(day);
    if (book.loan) return fail('book is on loan');
    if (book.queue.length > 0) {
      const front = book.queue[0];
      if (front.memberId !== memberId || front.readyUntil === null) return fail('book is reserved for someone else');
    }
    if (member.owed >= OWED_BLOCK_LIMIT) return fail('too much owed');
    const loans = loansOf(memberId);
    if (loans.length >= MAX_LOANS) return fail('loan limit reached');
    if (loans.some((l) => l.loan.due < day)) return fail('member has overdue books');
    if (book.queue.length > 0) book.queue.shift();
    const due = day + LOAN_DAYS;
    book.loan = { memberId, due, renewals: 0 };
    return { ok: true, dueDate: formatDay(due) };
  }

  function returnBook({ memberId, bookId, date } = {}) {
    const day = checkDate(date);
    if (day === null) return fail('bad date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown member or book');
    advance(day);
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to this member');
    const fine = fineFor(book.loan.due, day);
    member.owed += fine;
    book.loan = null;
    if (book.queue.length > 0) book.queue[0].readyUntil = day + PICKUP_DAYS - 1;
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date } = {}) {
    const day = checkDate(date);
    if (day === null) return fail('bad date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown member or book');
    advance(day);
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to this member');
    if (book.queue.length > 0) return fail('someone is waiting');
    if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
    if (book.loan.due < day) return fail('loan is overdue');
    if (member.owed >= OWED_BLOCK_LIMIT) return fail('too much owed');
    book.loan.due += LOAN_DAYS;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDay(book.loan.due) };
  }

  function placeHold({ memberId, bookId, date } = {}) {
    const day = checkDate(date);
    if (day === null) return fail('bad date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown member or book');
    advance(day);
    if (!book.loan && book.queue.length === 0) return fail('book is available; borrow it');
    if (book.loan && book.loan.memberId === memberId) return fail('member already has this book');
    if (book.queue.some((h) => h.memberId === memberId)) return fail('already holding');
    if (holdsOf(memberId).length >= MAX_HOLDS) return fail('hold limit reached');
    if (member.owed >= OWED_BLOCK_LIMIT) return fail('too much owed');
    book.queue.push({ memberId, readyUntil: null });
    return { ok: true, position: book.queue.length };
  }

  function payFine({ memberId, amount, date } = {}) {
    const day = checkDate(date);
    if (day === null) return fail('bad date');
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
    if (amount > member.owed) return fail('amount exceeds owed');
    advance(day);
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember({ memberId, date } = {}) {
    const day = checkDate(date);
    if (day === null) return fail('bad date');
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    advance(day);
    return {
      loans: loansOf(memberId).map(({ bookId, loan }) => ({ bookId, dueDate: formatDay(loan.due) })),
      owed: member.owed,
      holds: holdsOf(memberId).map((h) => ({
        bookId: h.bookId,
        position: h.position,
        readyUntil: h.readyUntil === null ? null : formatDay(h.readyUntil),
      })),
    };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
