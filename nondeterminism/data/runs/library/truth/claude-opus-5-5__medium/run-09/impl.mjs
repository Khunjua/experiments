const DAY_MS = 24 * 60 * 60 * 1000;
const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const OWED_LIMIT = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_PICKUP_DAYS = 3;

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toDays(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDays(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return fromDays(toDays(s) + n);
}

function isId(x) {
  return (typeof x === 'string' && x.length > 0) || (typeof x === 'number' && Number.isFinite(x));
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, holds: [memberId], readyUntil: string|null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function fail(reason) {
    return { ok: false, reason };
  }

  function processBook(book, date) {
    const d = toDays(date);
    while (book.readyUntil !== null && d > toDays(book.readyUntil)) {
      const old = book.readyUntil;
      book.holds.shift();
      book.readyUntil = book.holds.length > 0 ? addDays(old, HOLD_PICKUP_DAYS) : null;
    }
  }

  function processAll(date) {
    for (const book of books.values()) processBook(book, date);
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
      if (!isId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!isId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date');
      processAll(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book on loan');
      if (member.owed >= OWED_LIMIT) return fail('owes too much');
      if (loanCount(memberId) >= MAX_LOANS) return fail('too many loans');
      if (book.readyUntil !== null) {
        if (book.holds[0] !== memberId) return fail('set aside for another member');
        book.holds.shift();
        book.readyUntil = null;
      } else if (book.holds.length > 0) {
        // Should not happen (holds only exist on loaned/set-aside books); be safe.
        return fail('book has holds');
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date');
      processAll(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = toDays(date) - toDays(book.loan.dueDate);
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      book.loan = null;
      if (book.holds.length > 0) {
        book.readyUntil = addDays(date, HOLD_PICKUP_DAYS);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date');
      processAll(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.holds.length > 0) return fail('book has holds');
      if (toDays(date) > toDays(book.loan.dueDate)) return fail('overdue');
      book.loan.dueDate = addDays(book.loan.dueDate, LOAN_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date');
      processAll(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan && book.readyUntil === null) return fail('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
      if (book.holds.includes(memberId)) return fail('already holding');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date');
      processAll(date);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (typeof amount !== 'number' || !Number.isInteger(amount)) return fail('invalid amount');
      if (amount <= 0) return fail('non-positive amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date');
      processAll(date);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: idx === 0 && book.readyUntil !== null ? book.readyUntil : null,
          });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
