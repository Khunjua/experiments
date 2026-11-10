const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 1;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 1000;
const PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDay(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

function fromDay(n) {
  const dt = new Date(n * 86400000);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, setAside, queue }
  const members = new Map(); // memberId -> { owed, loanOrder: [] }

  function processExpirations(day) {
    for (const book of books.values()) {
      while (book.setAside && day > book.setAside.readyUntil) {
        const expiredEnd = book.setAside.readyUntil;
        book.setAside = null;
        if (book.queue.length > 0) {
          const next = book.queue.shift();
          book.setAside = { memberId: next, readyUntil: expiredEnd + PICKUP_DAYS };
        }
      }
    }
  }

  function prep(date) {
    const day = toDay(date);
    if (day === null) return null;
    processExpirations(day);
    return day;
  }

  function addBook({ bookId } = {}) {
    if (!validId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { loan: null, setAside: null, queue: [] });
    return { ok: true };
  }

  function addMember({ memberId } = {}) {
    if (!validId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0, loanOrder: [] });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date } = {}) {
    const day = prep(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (book.loan) return fail('book on loan');
    if (book.setAside && book.setAside.memberId !== memberId) return fail('book reserved for another member');
    if (member.owed >= BORROW_BLOCK_OWED) return fail('too much owed');
    if (book.setAside) book.setAside = null;
    const dueDay = day + LOAN_DAYS;
    book.loan = { memberId, dueDay, renewals: 0 };
    member.loanOrder.push(bookId);
    return { ok: true, dueDate: fromDay(dueDay) };
  }

  function returnBook({ memberId, bookId, date } = {}) {
    const day = prep(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by member');
    const daysLate = day - book.loan.dueDay;
    let fine = 0;
    if (daysLate > GRACE_DAYS) fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
    member.owed += fine;
    book.loan = null;
    member.loanOrder = member.loanOrder.filter((b) => b !== bookId);
    if (book.queue.length > 0) {
      const next = book.queue.shift();
      book.setAside = { memberId: next, readyUntil: day + PICKUP_DAYS };
    }
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date } = {}) {
    const day = prep(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by member');
    if (day > book.loan.dueDay) return fail('overdue');
    if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
    if (book.queue.length > 0 || book.setAside) return fail('others waiting');
    book.loan.renewals += 1;
    book.loan.dueDay += LOAN_DAYS;
    return { ok: true, dueDate: fromDay(book.loan.dueDay) };
  }

  function placeHold({ memberId, bookId, date } = {}) {
    const day = prep(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan && !book.setAside) return fail('book is available');
    if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
    if (book.setAside && book.setAside.memberId === memberId) return fail('already set aside for member');
    if (book.queue.includes(memberId)) return fail('already holding');
    book.queue.push(memberId);
    const position = book.queue.length + (book.setAside ? 1 : 0);
    return { ok: true, position };
  }

  function payFine({ memberId, amount, date } = {}) {
    const day = prep(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
    if (amount > member.owed) return fail('amount exceeds owed');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember({ memberId, date } = {}) {
    const day = prep(date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    const loans = member.loanOrder.map((bookId) => ({
      bookId,
      dueDate: fromDay(books.get(bookId).loan.dueDay),
    }));
    const holds = [];
    for (const [bookId, book] of books) {
      if (book.setAside && book.setAside.memberId === memberId) {
        holds.push({ bookId, position: 1, readyUntil: fromDay(book.setAside.readyUntil) });
      } else {
        const idx = book.queue.indexOf(memberId);
        if (idx >= 0) {
          holds.push({ bookId, position: idx + 1 + (book.setAside ? 1 : 0), readyUntil: null });
        }
      }
    }
    return { loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
