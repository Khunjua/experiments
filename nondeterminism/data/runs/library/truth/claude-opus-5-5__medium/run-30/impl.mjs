const DAY_MS = 86400000;

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === s;
}

function toDays(s) {
  return Math.round(Date.parse(s + 'T00:00:00Z') / DAY_MS);
}

function fromDays(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDays(toDays(s) + n);
}

function diffDays(a, b) {
  return toDays(a) - toDays(b);
}

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const OWED_LIMIT = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_PICKUP_DAYS = 3;

function isKey(v) {
  return (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v));
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, holds: [memberId], readyUntil: string|null }
  const books = new Map();
  // memberId -> { owed, loans: Set<bookId> }
  const members = new Map();

  function advance(date) {
    for (const book of books.values()) {
      while (
        !book.loan &&
        book.readyUntil !== null &&
        book.holds.length > 0 &&
        diffDays(date, book.readyUntil) > 0
      ) {
        book.holds.shift();
        if (book.holds.length > 0) {
          book.readyUntil = addDays(book.readyUntil, HOLD_PICKUP_DAYS);
        } else {
          book.readyUntil = null;
        }
      }
      if (!book.loan && book.holds.length === 0) book.readyUntil = null;
    }
  }

  function fail(reason) {
    return { ok: false, reason };
  }

  return {
    addBook({ bookId } = {}) {
      if (!isKey(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!isKey(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date');
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (member.owed >= OWED_LIMIT) return fail('owes too much');
      if (member.loans.size >= MAX_LOANS) return fail('loan limit');
      if (book.loan) return fail('book on loan');
      const setAside = book.readyUntil !== null && book.holds.length > 0;
      if (setAside && book.holds[0] !== memberId) return fail('set aside for another member');
      if (setAside) {
        book.holds.shift();
      }
      book.readyUntil = null;
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      member.loans.add(bookId);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date');
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = diffDays(date, book.loan.dueDate);
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      member.loans.delete(bookId);
      book.loan = null;
      if (book.holds.length > 0) {
        book.readyUntil = addDays(date, HOLD_PICKUP_DAYS);
      } else {
        book.readyUntil = null;
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date');
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not on loan to member');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.holds.length > 0) return fail('book has holds');
      if (diffDays(date, loan.dueDate) > 0) return fail('overdue');
      loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date');
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      const setAside = !book.loan && book.readyUntil !== null && book.holds.length > 0;
      if (!book.loan && !setAside) return fail('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
      if (book.holds.includes(memberId)) return fail('already holding');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date');
      advance(date);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (typeof amount !== 'number' || !Number.isInteger(amount)) return fail('invalid amount');
      if (amount <= 0) return fail('non-positive amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      if (isValidDate(date)) advance(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = [];
      for (const bookId of member.loans) {
        loans.push({ bookId, dueDate: books.get(bookId).loan.dueDate });
      }
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.holds.indexOf(memberId);
        if (idx === -1) continue;
        const readyUntil =
          idx === 0 && !book.loan && book.readyUntil !== null ? book.readyUntil : null;
        holds.push({ bookId, position: idx + 1, readyUntil });
      }
      return { loans, owed: member.owed, holds };
    },
  };
}
