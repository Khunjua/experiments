const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 1000;
const HOLD_PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

function formatDay(n) {
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
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals} | null, holds: [{memberId, readyUntil}] }
  const members = new Map(); // memberId -> { owed, loans: [bookId] (borrow order) }

  function processBook(book, day) {
    while (book.holds.length > 0 && book.holds[0].readyUntil !== null && day > book.holds[0].readyUntil) {
      const expired = book.holds.shift();
      if (book.holds.length > 0) {
        const setAsideDay = expired.readyUntil + 1;
        book.holds[0].readyUntil = setAsideDay + HOLD_PICKUP_DAYS;
      }
    }
  }

  function advance(day) {
    for (const book of books.values()) processBook(book, day);
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('duplicate book');
      books.set(bookId, { loan: null, holds: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('duplicate member');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book is on loan');
      if (member.owed >= BORROW_BLOCK_OWED) return fail('too much owed');
      for (const bId of member.loans) {
        if (books.get(bId).loan.due < day) return fail('member has overdue loans');
      }
      if (book.holds.length > 0) {
        const first = book.holds[0];
        if (first.memberId !== memberId || first.readyUntil === null) return fail('book is set aside for another member');
        book.holds.shift();
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      member.loans.push(bookId);
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to this member');
      const daysLate = Math.max(0, day - book.loan.due);
      const fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      member.owed += fine;
      book.loan = null;
      member.loans = member.loans.filter((b) => b !== bookId);
      if (book.holds.length > 0) book.holds[0].readyUntil = day + HOLD_PICKUP_DAYS;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not on loan to this member');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.holds.length > 0) return fail('others are waiting');
      if (day > loan.due) return fail('loan is overdue');
      loan.due = loan.due + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan && book.holds.length === 0) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member already has the book');
      if (book.holds.some((h) => h.memberId === memberId)) return fail('already holding');
      book.holds.push({ memberId, readyUntil: null });
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('amount exceeds owed');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const loans = member.loans.map((bookId) => ({ bookId, dueDate: formatDay(books.get(bookId).loan.due) }));
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.holds.findIndex((h) => h.memberId === memberId);
        if (idx >= 0) {
          const h = book.holds[idx];
          holds.push({ bookId, position: idx + 1, readyUntil: h.readyUntil === null ? null : formatDay(h.readyUntil) });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
