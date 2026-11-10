const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function formatDate(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(id) {
  return id !== undefined && id !== null && id !== '';
}

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_PICKUP_DAYS = 3;

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, holds: [memberId], readyUntil: number|null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function settleBook(book, today) {
    while (book.readyUntil !== null && today > book.readyUntil) {
      book.holds.shift();
      if (book.holds.length > 0) {
        book.readyUntil += HOLD_PICKUP_DAYS;
      } else {
        book.readyUntil = null;
      }
    }
  }

  function settleAll(today) {
    for (const book of books.values()) settleBook(book, today);
  }

  function loanCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  function fail(reason) {
    return { ok: false, reason };
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
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      settleAll(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book on loan');
      if (book.readyUntil !== null && book.holds[0] !== memberId) return fail('book set aside for another member');
      if (loanCount(memberId) >= MAX_LOANS) return fail('loan limit');
      if (member.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
      if (book.readyUntil !== null) {
        book.holds.shift();
        book.readyUntil = null;
      }
      const due = today + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      return { ok: true, dueDate: formatDate(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      settleAll(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const daysLate = today - book.loan.due;
      let fine = 0;
      if (daysLate > GRACE_DAYS) fine = Math.min(daysLate * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      book.loan = null;
      if (book.holds.length > 0) book.readyUntil = today + HOLD_PICKUP_DAYS;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      settleAll(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.holds.length > 0) return fail('book has holds');
      if (today > book.loan.due) return fail('overdue');
      book.loan.due += LOAN_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: formatDate(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      settleAll(today);
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
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      settleAll(today);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (typeof amount !== 'number' || !Number.isInteger(amount)) return fail('invalid amount');
      if (amount <= 0) return fail('non-positive amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const today = parseDate(date);
      if (today !== null) settleAll(today);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: formatDate(book.loan.due) });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: idx === 0 && book.readyUntil !== null ? formatDate(book.readyUntil) : null,
          });
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };
}
