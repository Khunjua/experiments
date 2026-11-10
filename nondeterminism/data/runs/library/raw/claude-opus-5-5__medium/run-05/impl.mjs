const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 500;
const BLOCK_OWED_THRESHOLD = 500;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;

const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDay(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
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

function addDays(s, n) {
  return fromDay(toDay(s) + n);
}

function isId(x) {
  return (typeof x === 'string' && x.length > 0) || (typeof x === 'number' && Number.isFinite(x));
}

const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, queue: [{memberId, seq}], readyUntil }
  const members = new Map(); // memberId -> { owed }
  let seq = 0;

  function processDate(date) {
    const today = toDay(date);
    for (const book of books.values()) {
      while (!book.loan && book.queue.length > 0 && book.readyUntil !== null && toDay(book.readyUntil) < today) {
        const prevUntil = book.readyUntil;
        book.queue.shift();
        book.readyUntil = book.queue.length > 0 ? addDays(prevUntil, PICKUP_DAYS) : null;
      }
    }
  }

  function loanCount(memberId) {
    let n = 0;
    for (const b of books.values()) if (b.loan && b.loan.memberId === memberId) n++;
    return n;
  }

  return {
    addBook({ bookId } = {}) {
      if (!isId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!isId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      if (toDay(date) === null) return fail('invalid date');
      processDate(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book is on loan');
      if (book.queue.length > 0 && book.queue[0].memberId !== memberId) return fail('book is set aside for another member');
      if (member.owed >= BLOCK_OWED_THRESHOLD) return fail('too much owed');
      if (loanCount(memberId) >= MAX_LOANS) return fail('loan limit reached');
      if (book.queue.length > 0) {
        book.queue.shift();
        book.readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0, seq: ++seq };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (toDay(date) === null) return fail('invalid date');
      processDate(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by this member');
      const late = toDay(date) - toDay(book.loan.dueDate);
      const fine = Math.min(Math.max(0, late) * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      member.owed += fine;
      book.loan = null;
      book.readyUntil = book.queue.length > 0 ? addDays(date, PICKUP_DAYS) : null;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (toDay(date) === null) return fail('invalid date');
      processDate(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not borrowed by this member');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.queue.length > 0) return fail('others are waiting');
      if (toDay(date) > toDay(loan.dueDate)) return fail('loan is overdue');
      if (member.owed >= BLOCK_OWED_THRESHOLD) return fail('too much owed');
      const dueDate = addDays(date, LOAN_DAYS);
      loan.dueDate = dueDate;
      loan.renewals++;
      return { ok: true, dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (toDay(date) === null) return fail('invalid date');
      processDate(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan && book.queue.length === 0) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member has this book');
      if (book.queue.some((h) => h.memberId === memberId)) return fail('already holding');
      book.queue.push({ memberId, seq: ++seq });
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      if (toDay(date) === null) return fail('invalid date');
      processDate(date);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('amount exceeds owed');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      if (toDay(date) === null) return fail('invalid date');
      processDate(date);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate, _s: book.loan.seq });
        }
        const idx = book.queue.findIndex((h) => h.memberId === memberId);
        if (idx >= 0) {
          const readyUntil = !book.loan && idx === 0 ? book.readyUntil : null;
          holds.push({ bookId, position: idx + 1, readyUntil, _s: book.queue[idx].seq });
        }
      }
      loans.sort((a, b) => a._s - b._s);
      holds.sort((a, b) => a._s - b._s);
      return {
        ok: true,
        loans: loans.map(({ bookId, dueDate }) => ({ bookId, dueDate })),
        owed: member.owed,
        holds: holds.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil })),
      };
    },
  };
}
