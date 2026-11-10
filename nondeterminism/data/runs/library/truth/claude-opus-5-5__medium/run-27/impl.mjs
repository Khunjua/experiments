const DAY_MS = 86400000;

function toDays(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDays(days) {
  const dt = new Date(days * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, n) {
  return fromDays(toDays(dateStr) + n);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fromDays(toDays(s)) === s;
}

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const OWED_LIMIT = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_PICKUP_DAYS = 3;

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, holds: [memberId], readyUntil: string|null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

  function validId(id) {
    return id !== undefined && id !== null;
  }

  // Advance set-aside expirations up to the given date.
  function processDate(date) {
    if (!isValidDate(date)) return;
    const today = toDays(date);
    for (const book of books.values()) {
      while (
        !book.loan &&
        book.holds.length > 0 &&
        book.readyUntil !== null &&
        today > toDays(book.readyUntil)
      ) {
        const oldReady = book.readyUntil;
        book.holds.shift();
        book.readyUntil = book.holds.length > 0 ? addDays(oldReady, HOLD_PICKUP_DAYS) : null;
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
      if (!validId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date', { dueDate: null });
      processDate(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member', { dueDate: null });
      if (!book) return fail('unknown book', { dueDate: null });
      if (book.loan) return fail('book on loan', { dueDate: null });
      if (book.readyUntil !== null && book.holds.length > 0 && book.holds[0] !== memberId) {
        return fail('set aside for another member', { dueDate: null });
      }
      if (member.owed >= OWED_LIMIT) return fail('owes too much', { dueDate: null });
      if (loanCount(memberId) >= MAX_LOANS) return fail('loan limit', { dueDate: null });

      if (book.readyUntil !== null && book.holds.length > 0 && book.holds[0] === memberId) {
        book.holds.shift();
        book.readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date', { fine: 0 });
      processDate(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to member', { fine: 0 });
      }
      const late = toDays(date) - toDays(book.loan.dueDate);
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      book.loan = null;
      book.readyUntil = book.holds.length > 0 ? addDays(date, HOLD_PICKUP_DAYS) : null;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date', { dueDate: null });
      processDate(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to member', { dueDate: null });
      }
      const loan = book.loan;
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit', { dueDate: null });
      if (book.holds.length > 0) return fail('book has holds', { dueDate: null });
      if (toDays(date) > toDays(loan.dueDate)) return fail('overdue', { dueDate: null });
      loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return fail('invalid date', { position: null });
      processDate(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member', { position: null });
      if (!book) return fail('unknown book', { position: null });
      const setAside = !book.loan && book.readyUntil !== null && book.holds.length > 0;
      if (!book.loan && !setAside) return fail('book is on the shelf', { position: null });
      if (book.loan && book.loan.memberId === memberId) return fail('member has book', { position: null });
      if (book.holds.includes(memberId)) return fail('already holding', { position: null });
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      if (isValidDate(date)) processDate(date);
      const member = members.get(memberId);
      if (!member) return fail('unknown member', { owed: 0 });
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return fail('invalid amount', { owed: member.owed });
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      if (isValidDate(date)) processDate(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          const setAsideForMe = idx === 0 && !book.loan && book.readyUntil !== null;
          holds.push({ bookId, position: idx + 1, readyUntil: setAsideForMe ? book.readyUntil : null });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
