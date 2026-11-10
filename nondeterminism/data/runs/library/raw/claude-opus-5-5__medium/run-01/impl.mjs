const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

function formatDay(day) {
  const dt = new Date(day * 86400000);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDay, renewals } | null, queue: [memberId], readyFor: memberId|null, readyUntil: day|null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();
  const fail = (reason) => ({ ok: false, reason });

  function processBook(book, today) {
    while (book.readyFor !== null && today > book.readyUntil) {
      const expiredUntil = book.readyUntil;
      book.queue.shift();
      if (book.queue.length > 0) {
        book.readyFor = book.queue[0];
        book.readyUntil = expiredUntil + PICKUP_DAYS;
      } else {
        book.readyFor = null;
        book.readyUntil = null;
      }
    }
  }

  function processAll(today) {
    for (const book of books.values()) processBook(book, today);
  }

  function addBook({ bookId } = {}) {
    if (!validId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { loan: null, queue: [], readyFor: null, readyUntil: null });
    return { ok: true };
  }

  function addMember({ memberId } = {}) {
    if (!validId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date } = {}) {
    const today = parseDate(date);
    if (today === null) return fail('invalid date');
    processAll(today);
    if (!members.has(memberId)) return fail('unknown member');
    const book = books.get(bookId);
    if (!book) return fail('unknown book');
    if (book.loan) return fail('book on loan');
    if (book.readyFor !== null && book.readyFor !== memberId) return fail('book set aside for another member');
    if (book.readyFor === memberId) {
      book.queue.shift();
      book.readyFor = null;
      book.readyUntil = null;
      if (book.queue.length > 0) {
        // remaining holders keep waiting for the next return
      }
    } else if (book.queue.length > 0) {
      return fail('book has holds');
    }
    const dueDay = today + LOAN_DAYS;
    book.loan = { memberId, dueDay, renewals: 0 };
    return { ok: true, dueDate: formatDay(dueDay) };
  }

  function returnBook({ memberId, bookId, date } = {}) {
    const today = parseDate(date);
    if (today === null) return fail('invalid date');
    processAll(today);
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    const book = books.get(bookId);
    if (!book) return fail('unknown book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
    const lateDays = Math.max(0, today - book.loan.dueDay);
    const fine = Math.min(lateDays * FINE_PER_DAY, MAX_FINE_PER_LOAN);
    member.owed += fine;
    book.loan = null;
    if (book.queue.length > 0) {
      book.readyFor = book.queue[0];
      book.readyUntil = today + PICKUP_DAYS;
    }
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date } = {}) {
    const today = parseDate(date);
    if (today === null) return fail('invalid date');
    processAll(today);
    if (!members.has(memberId)) return fail('unknown member');
    const book = books.get(bookId);
    if (!book) return fail('unknown book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
    if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
    if (book.queue.length > 0) return fail('book has holds');
    if (today > book.loan.dueDay) return fail('loan overdue');
    book.loan.dueDay += LOAN_DAYS;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDay(book.loan.dueDay) };
  }

  function placeHold({ memberId, bookId, date } = {}) {
    const today = parseDate(date);
    if (today === null) return fail('invalid date');
    processAll(today);
    if (!members.has(memberId)) return fail('unknown member');
    const book = books.get(bookId);
    if (!book) return fail('unknown book');
    if (!book.loan && book.readyFor === null) return fail('book is available');
    if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
    if (book.queue.includes(memberId)) return fail('already holding');
    book.queue.push(memberId);
    return { ok: true, position: book.queue.length };
  }

  function payFine({ memberId, amount, date } = {}) {
    const today = parseDate(date);
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
    const today = parseDate(date);
    if (today !== null) processAll(today);
    const member = members.get(memberId);
    if (!member || today === null) return { ok: false, loans: [], owed: 0, holds: [] };
    const loans = [];
    const holds = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) {
        loans.push({ bookId, dueDate: formatDay(book.loan.dueDay) });
      }
      const idx = book.queue.indexOf(memberId);
      if (idx !== -1) {
        holds.push({
          bookId,
          position: idx + 1,
          readyUntil: book.readyFor === memberId ? formatDay(book.readyUntil) : null,
        });
      }
    }
    return { loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
