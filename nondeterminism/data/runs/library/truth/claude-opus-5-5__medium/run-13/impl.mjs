const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_PICKUP_DAYS = 3;
const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return t;
}

function formatDate(t) {
  return new Date(t).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return formatDate(parseDate(s) + n * DAY_MS);
}

function diffDays(a, b) {
  // b - a in days
  return Math.round((parseDate(b) - parseDate(a)) / DAY_MS);
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

function fail(reason, extra) {
  return Object.assign({ ok: false, reason }, extra || {});
}

export function createLibrary() {
  const books = new Map(); // bookId -> { loan: {memberId, dueDate, renewals} | null, holds: [memberId], readyUntil: string|null }
  const members = new Map(); // memberId -> { owed }

  function advance(date) {
    for (const book of books.values()) {
      if (book.loan) continue;
      while (book.readyUntil !== null && date > book.readyUntil) {
        const old = book.readyUntil;
        book.holds.shift();
        book.readyUntil = book.holds.length > 0 ? addDays(old, HOLD_PICKUP_DAYS) : null;
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
      if (parseDate(date) === null) return fail('invalid date');
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book on loan');
      const setAside = book.readyUntil !== null;
      if (setAside && book.holds[0] !== memberId) return fail('book set aside for another member');
      if (member.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
      if (loanCount(memberId) >= MAX_LOANS) return fail('loan limit reached');
      if (setAside) {
        book.holds.shift();
        book.readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date', { fine: 0 });
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to member', { fine: 0 });
      }
      const late = diffDays(book.loan.dueDate, date);
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      book.loan = null;
      book.readyUntil = book.holds.length > 0 ? addDays(date, HOLD_PICKUP_DAYS) : null;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      advance(date);
      const book = books.get(bookId);
      if (!members.has(memberId) || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to member');
      }
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.holds.length > 0) return fail('book has holds');
      if (date > book.loan.dueDate) return fail('overdue');
      book.loan.dueDate = addDays(book.loan.dueDate, LOAN_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      advance(date);
      const book = books.get(bookId);
      if (!members.has(memberId)) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan && book.readyUntil === null) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
      if (book.holds.includes(memberId)) return fail('duplicate hold');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      advance(date);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return fail('invalid amount', { owed: member.owed });
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      if (parseDate(date) !== null) advance(date);
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
          const readyUntil = idx === 0 && !book.loan && book.readyUntil !== null ? book.readyUntil : null;
          holds.push({ bookId, position: idx + 1, readyUntil });
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };
}
