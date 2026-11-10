const DAY_MS = 86400000;

function toDays(s) {
  if (typeof s !== 'string') return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return NaN;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return NaN;
  return Math.round(t / DAY_MS);
}

function fromDays(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
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
  // bookId -> { loan: null | { memberId, due (days), renewals }, holds: [memberId], readyUntil: null | days }
  const books = new Map();
  // memberId -> { owed, loans: Set<bookId> }
  const members = new Map();

  function fail(reason) {
    return { ok: false, reason };
  }

  function validId(id) {
    return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
  }

  // Bring set-aside state up to date for the given day.
  function advance(day) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && day > book.readyUntil) {
        book.holds.shift();
        if (book.holds.length > 0) {
          book.readyUntil = book.readyUntil + HOLD_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  function prepare(memberId, date) {
    const day = toDays(date);
    if (Number.isNaN(day)) return { error: 'invalid date' };
    advance(day);
    const member = members.get(memberId);
    if (!member) return { error: 'unknown member', day };
    return { day, member };
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
      const p = prepare(memberId, date);
      if (p.error) return fail(p.error);
      const { day, member } = p;
      const book = books.get(bookId);
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book on loan');
      if (book.readyUntil !== null && book.holds[0] !== memberId) return fail('set aside for another member');
      if (member.loans.size >= MAX_LOANS) return fail('loan limit');
      if (member.owed >= OWED_LIMIT) return fail('owes too much');
      if (book.readyUntil !== null) {
        book.holds.shift();
        book.readyUntil = null;
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      member.loans.add(bookId);
      return { ok: true, dueDate: fromDays(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const p = prepare(memberId, date);
      if (p.error) return fail(p.error);
      const { day, member } = p;
      const book = books.get(bookId);
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = day - book.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      member.loans.delete(bookId);
      book.loan = null;
      if (book.holds.length > 0) {
        book.readyUntil = day + HOLD_DAYS;
      } else {
        book.readyUntil = null;
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const p = prepare(memberId, date);
      if (p.error) return fail(p.error);
      const { day } = p;
      const book = books.get(bookId);
      if (!book) return fail('unknown book');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not on loan to member');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.holds.length > 0) return fail('book has holds');
      if (day > loan.due) return fail('overdue');
      loan.due += LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: fromDays(loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const p = prepare(memberId, date);
      if (p.error) return fail(p.error);
      const book = books.get(bookId);
      if (!book) return fail('unknown book');
      if (!book.loan && book.readyUntil === null) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
      if (book.holds.includes(memberId)) return fail('duplicate hold');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const p = prepare(memberId, date);
      if (p.error) return fail(p.error);
      const { member } = p;
      if (typeof amount !== 'number' || !Number.isInteger(amount)) return fail('invalid amount');
      if (amount <= 0) return fail('amount must be positive');
      if (amount > member.owed) return fail('amount exceeds owed');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const p = prepare(memberId, date);
      if (p.error) return { ok: false, reason: p.error, loans: [], owed: 0, holds: [] };
      const { member } = p;
      const loans = [];
      for (const bookId of member.loans) {
        const book = books.get(bookId);
        loans.push({ bookId, dueDate: fromDays(book.loan.due) });
      }
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.holds.indexOf(memberId);
        if (idx === -1) continue;
        const readyUntil = idx === 0 && book.readyUntil !== null ? fromDays(book.readyUntil) : null;
        holds.push({ bookId, position: idx + 1, readyUntil });
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
