const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const FINE_PER_DAY = 25;
const FREE_LATE_DAYS = 2;
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

function formatDay(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // book: { loan: { memberId, due, renewals } | null, queue: [memberId], readyUntil: number | null }
  const books = new Map();
  // member: { owed, loans: Set<bookId> }
  const members = new Map();

  function advanceBook(book, day) {
    while (book.readyUntil !== null && day > book.readyUntil) {
      book.queue.shift();
      if (book.queue.length > 0) {
        book.readyUntil = book.readyUntil + HOLD_PICKUP_DAYS;
      } else {
        book.readyUntil = null;
      }
    }
  }

  function advanceAll(day) {
    for (const book of books.values()) advanceBook(book, day);
  }

  function lookup(memberId, bookId, date) {
    const day = parseDate(date);
    if (day === null) return { err: fail('invalid date') };
    const member = members.get(memberId);
    if (!member) return { err: fail('unknown member') };
    const book = books.get(bookId);
    if (!book) return { err: fail('unknown book') };
    advanceAll(day);
    return { day, member, book };
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid or duplicate book');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid or duplicate member');
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const r = lookup(memberId, bookId, date);
      if (r.err) return r.err;
      const { day, member, book } = r;
      if (book.loan) return fail('book on loan');
      if (book.readyUntil !== null && book.queue[0] !== memberId) return fail('book set aside for another member');
      if (member.loans.size >= MAX_LOANS) return fail('loan limit reached');
      if (member.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
      if (book.readyUntil !== null) {
        book.queue.shift();
        book.readyUntil = null;
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      member.loans.add(bookId);
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const r = lookup(memberId, bookId, date);
      if (r.err) return r.err;
      const { day, member, book } = r;
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = day - book.loan.due;
      let fine = 0;
      if (late > FREE_LATE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      member.loans.delete(bookId);
      book.loan = null;
      if (book.queue.length > 0) book.readyUntil = day + HOLD_PICKUP_DAYS;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const r = lookup(memberId, bookId, date);
      if (r.err) return r.err;
      const { day, book } = r;
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      if (day > book.loan.due) return fail('overdue');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.queue.length > 0) return fail('book has holds');
      book.loan.due += LOAN_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: formatDay(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const r = lookup(memberId, bookId, date);
      if (r.err) return r.err;
      const { book } = r;
      if (!book.loan && book.readyUntil === null) return fail('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
      if (book.queue.includes(memberId)) return fail('already holding');
      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      advanceAll(day);
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      advanceAll(day);
      const loans = [];
      for (const bookId of member.loans) {
        loans.push({ bookId, dueDate: formatDay(books.get(bookId).loan.due) });
      }
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.queue.indexOf(memberId);
        if (idx === -1) continue;
        const readyUntil = idx === 0 && book.readyUntil !== null ? formatDay(book.readyUntil) : null;
        holds.push({ bookId, position: idx + 1, readyUntil });
      }
      return { loans, owed: member.owed, holds };
    },
  };
}
