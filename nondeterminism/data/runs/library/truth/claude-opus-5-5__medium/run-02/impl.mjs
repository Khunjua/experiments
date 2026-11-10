const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(ms / DAY_MS);
}

function formatDay(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const OWED_LIMIT = 1000;
const FINE_PER_DAY = 25;
const FREE_LATE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_DAYS = 3;

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, holds: [memberId], readyUntil }
  const members = new Map(); // memberId -> { owed }

  const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

  function advance(today) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && today > book.readyUntil) {
        book.holds.shift();
        if (book.holds.length > 0) {
          book.readyUntil = book.readyUntil + HOLD_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  function loanCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date', { dueDate: null });
      advance(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member', { dueDate: null });
      if (!book) return fail('unknown book', { dueDate: null });
      if (book.loan) return fail('book on loan', { dueDate: null });
      if (book.readyUntil !== null && book.holds[0] !== memberId) {
        return fail('book set aside for another member', { dueDate: null });
      }
      if (loanCount(memberId) >= MAX_LOANS) return fail('loan limit', { dueDate: null });
      if (member.owed >= OWED_LIMIT) return fail('owes too much', { dueDate: null });

      if (book.readyUntil !== null) {
        book.holds.shift();
        book.readyUntil = null;
      }
      const due = today + LOAN_DAYS;
      book.loan = { memberId, dueDate: due, renewals: 0 };
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date', { fine: 0 });
      advance(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to member', { fine: 0 });
      }
      const late = today - book.loan.dueDate;
      let fine = 0;
      if (late > FREE_LATE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      book.loan = null;
      if (book.holds.length > 0) {
        book.readyUntil = today + HOLD_DAYS;
      } else {
        book.readyUntil = null;
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date', { dueDate: null });
      advance(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to member', { dueDate: null });
      }
      const loan = book.loan;
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit', { dueDate: null });
      if (book.holds.length > 0) return fail('book has holds', { dueDate: null });
      if (today > loan.dueDate) return fail('overdue', { dueDate: null });
      loan.dueDate += LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.dueDate) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date', { position: null });
      advance(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member', { position: null });
      if (!book) return fail('unknown book', { position: null });
      if (!book.loan && book.readyUntil === null) return fail('book is on the shelf', { position: null });
      if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan', { position: null });
      if (book.holds.includes(memberId)) return fail('already holding', { position: null });
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date', { owed: null });
      advance(today);
      const member = members.get(memberId);
      if (!member) return fail('unknown member', { owed: null });
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
        return fail('invalid amount', { owed: member.owed });
      }
      if (amount > member.owed) return fail('overpayment', { owed: member.owed });
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const today = parseDate(date);
      if (today !== null) advance(today);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: formatDay(book.loan.dueDate) });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          const readyUntil = idx === 0 && book.readyUntil !== null ? formatDay(book.readyUntil) : null;
          holds.push({ bookId, position: idx + 1, readyUntil });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
