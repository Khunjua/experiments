const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function formatDay(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const OWED_LIMIT = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_DAYS = 3;

export function createLibrary() {
  // bookId -> { loan: {memberId, due, renewals} | null, holds: [memberId], readyUntil: day | null }
  const books = new Map();
  // memberId -> { owed, loans: Set<bookId> }
  const members = new Map();

  function processExpiry(today) {
    for (const book of books.values()) {
      while (book.loan === null && book.readyUntil !== null && today > book.readyUntil) {
        book.holds.shift();
        if (book.holds.length > 0) {
          book.readyUntil = book.readyUntil + HOLD_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
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
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      processExpiry(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan !== null) return fail('book on loan');
      if (book.readyUntil !== null && book.holds[0] !== memberId) return fail('book set aside for another member');
      if (member.loans.size >= MAX_LOANS) return fail('loan limit');
      if (member.owed >= OWED_LIMIT) return fail('owes too much');
      if (book.readyUntil !== null) {
        book.holds.shift();
        book.readyUntil = null;
      }
      const due = today + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      member.loans.add(bookId);
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      processExpiry(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (book.loan === null || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = today - book.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      member.loans.delete(bookId);
      book.loan = null;
      book.readyUntil = book.holds.length > 0 ? today + HOLD_DAYS : null;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      processExpiry(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (book.loan === null || book.loan.memberId !== memberId) return fail('not on loan to member');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.holds.length > 0) return fail('book has holds');
      if (today > book.loan.due) return fail('overdue');
      book.loan.due += LOAN_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: formatDay(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      processExpiry(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (book.loan === null && book.readyUntil === null) return fail('book is on the shelf');
      if (book.loan !== null && book.loan.memberId === memberId) return fail('member has the book');
      if (book.holds.includes(memberId)) return fail('already holding');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      processExpiry(today);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return { ok: false, reason: 'invalid date', loans: [], owed: 0, holds: [] };
      processExpiry(today);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = [];
      for (const bookId of member.loans) {
        const book = books.get(bookId);
        loans.push({ bookId, dueDate: formatDay(book.loan.due) });
      }
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.holds.indexOf(memberId);
        if (idx === -1) continue;
        const setAside = idx === 0 && book.loan === null && book.readyUntil !== null;
        holds.push({
          bookId,
          position: idx + 1,
          readyUntil: setAside ? formatDay(book.readyUntil) : null,
        });
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
