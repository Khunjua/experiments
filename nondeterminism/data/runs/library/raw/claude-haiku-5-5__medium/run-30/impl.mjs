const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const PICKUP_DAYS = 3;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const BLOCK_OWED = 1000;

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function dayNum(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDate, renewals }, queue: [memberId], readyUntil: null | date }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Lapse set-aside books whose pickup window ended before `date`.
  function advance(date) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && book.readyUntil < date) {
        book.queue.shift();
        book.readyUntil = book.queue.length ? addDays(book.readyUntil, PICKUP_DAYS) : null;
      }
    }
  }

  function loansOf(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) {
        out.push({ bookId, loan: book.loan });
      }
    }
    return out;
  }

  function blocked(member) {
    return member.owed >= BLOCK_OWED;
  }

  function addBook({ bookId } = {}) {
    if (bookId === undefined || bookId === null || books.has(bookId)) return { ok: false };
    books.set(bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember({ memberId } = {}) {
    if (memberId === undefined || memberId === null || members.has(memberId)) return { ok: false };
    members.set(memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date } = {}) {
    if (!isDate(date)) return { ok: false };
    advance(date);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (blocked(member)) return { ok: false };
    if (book.loan) return { ok: false };
    if (book.readyUntil !== null && book.queue[0] !== memberId) return { ok: false };
    if (loansOf(memberId).length >= MAX_LOANS) return { ok: false };

    if (book.readyUntil !== null) {
      book.queue.shift();
      book.readyUntil = null;
    }
    const dueDate = addDays(date, LOAN_DAYS);
    book.loan = { memberId, dueDate, renewals: 0 };
    return { ok: true, dueDate };
  }

  function returnBook({ memberId, bookId, date } = {}) {
    if (!isDate(date)) return { ok: false, fine: 0 };
    advance(date);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
      return { ok: false, fine: 0 };
    }
    const late = dayNum(date) - dayNum(book.loan.dueDate);
    const fine = Math.min(Math.max(0, late - GRACE_DAYS) * FINE_PER_DAY, FINE_CAP);
    member.owed += fine;
    book.loan = null;
    if (book.queue.length > 0) {
      book.readyUntil = addDays(date, PICKUP_DAYS);
    }
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date } = {}) {
    if (!isDate(date)) return { ok: false };
    advance(date);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book || !book.loan || book.loan.memberId !== memberId) return { ok: false };
    if (blocked(member)) return { ok: false };
    if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (date > book.loan.dueDate) return { ok: false };
    if (book.queue.length > 0) return { ok: false };
    book.loan.dueDate = addDays(date, LOAN_DAYS);
    book.loan.renewals += 1;
    return { ok: true, dueDate: book.loan.dueDate };
  }

  function placeHold({ memberId, bookId, date } = {}) {
    if (!isDate(date)) return { ok: false };
    advance(date);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (blocked(member)) return { ok: false };
    if (book.loan === null && book.queue.length === 0) return { ok: false };
    if (book.loan && book.loan.memberId === memberId) return { ok: false };
    if (book.queue.includes(memberId)) return { ok: false };
    book.queue.push(memberId);
    return { ok: true, position: book.queue.length };
  }

  function payFine({ memberId, amount, date } = {}) {
    if (!isDate(date)) return { ok: false };
    advance(date);
    const member = members.get(memberId);
    if (!member) return { ok: false };
    if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) return { ok: false };
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember({ memberId, date } = {}) {
    if (isDate(date)) advance(date);
    const member = members.get(memberId);
    if (!member) return { loans: [], owed: 0, holds: [] };

    const loans = loansOf(memberId).map(({ bookId, loan }) => ({
      bookId,
      dueDate: loan.dueDate,
    }));

    const holds = [];
    for (const [bookId, book] of books) {
      const idx = book.queue.indexOf(memberId);
      if (idx === -1) continue;
      const readyUntil = idx === 0 && book.readyUntil !== null ? book.readyUntil : null;
      holds.push({ bookId, position: idx + 1, readyUntil });
    }

    return { loans, owed: member.owed, holds };
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
