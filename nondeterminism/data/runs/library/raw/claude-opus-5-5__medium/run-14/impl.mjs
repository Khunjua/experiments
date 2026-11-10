const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;

const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDay(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  if (d.toISOString().slice(0, 10) !== s) return null;
  return Math.round(t / DAY_MS);
}

function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function isId(x) {
  return (typeof x === 'string' && x.length > 0) || (typeof x === 'number' && Number.isFinite(x));
}

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, holds: [{ memberId, readyUntil: dayNum|null }] }
  const books = new Map();
  // memberId -> { owed, loanOrder: [bookId] }
  const members = new Map();
  const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

  function setAsideNext(book, startDay) {
    if (book.loan === null && book.holds.length > 0 && book.holds[0].readyUntil === null) {
      book.holds[0].readyUntil = startDay + PICKUP_DAYS;
    }
  }

  function advance(day) {
    if (day === null) return;
    for (const book of books.values()) {
      while (book.loan === null && book.holds.length > 0 &&
             book.holds[0].readyUntil !== null && book.holds[0].readyUntil < day) {
        const expired = book.holds.shift();
        if (book.holds.length > 0) {
          book.holds[0].readyUntil = expired.readyUntil + 1 + PICKUP_DAYS;
        }
      }
    }
  }

  function memberLoans(memberId) {
    const m = members.get(memberId);
    return m.loanOrder.map((bookId) => ({ bookId, due: books.get(bookId).loan.due }));
  }

  return {
    addBook({ bookId } = {}) {
      if (!isId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, holds: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!isId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0, loanOrder: [] });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const day = toDay(date);
      if (day === null) return fail('invalid date', { dueDate: null });
      advance(day);
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m) return fail('unknown member', { dueDate: null });
      if (!book) return fail('unknown book', { dueDate: null });
      if (book.loan) return fail('book is out', { dueDate: null });
      if (book.holds.length > 0 && book.holds[0].memberId !== memberId) {
        return fail('book reserved for another member', { dueDate: null });
      }
      if (m.loanOrder.length >= MAX_LOANS) return fail('too many loans', { dueDate: null });
      if (memberLoans(memberId).some((l) => l.due < day)) return fail('has overdue loans', { dueDate: null });
      if (m.owed >= BORROW_BLOCK_OWED) return fail('owes too much', { dueDate: null });
      if (book.holds.length > 0) book.holds.shift();
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      m.loanOrder.push(bookId);
      return { ok: true, dueDate: fromDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = toDay(date);
      if (day === null) return fail('invalid date', { fine: 0 });
      advance(day);
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m || !book) return fail('unknown member or book', { fine: 0 });
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member', { fine: 0 });
      const lateDays = Math.max(0, day - book.loan.due);
      const fine = Math.min(lateDays * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      m.owed += fine;
      book.loan = null;
      m.loanOrder = m.loanOrder.filter((b) => b !== bookId);
      setAsideNext(book, day);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = toDay(date);
      if (day === null) return fail('invalid date', { dueDate: null });
      advance(day);
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m || !book) return fail('unknown member or book', { dueDate: null });
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member', { dueDate: null });
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached', { dueDate: null });
      if (book.holds.length > 0) return fail('others are waiting', { dueDate: null });
      if (day > book.loan.due) return fail('loan is overdue', { dueDate: null });
      book.loan.due += LOAN_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: fromDay(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = toDay(date);
      if (day === null) return fail('invalid date', { position: null });
      advance(day);
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m || !book) return fail('unknown member or book', { position: null });
      if (!book.loan && book.holds.length === 0) return fail('book is available', { position: null });
      if (book.loan && book.loan.memberId === memberId) return fail('member has the book', { position: null });
      if (book.holds.some((h) => h.memberId === memberId)) return fail('already holding', { position: null });
      book.holds.push({ memberId, readyUntil: null });
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = toDay(date);
      if (day === null) return fail('invalid date', { owed: null });
      advance(day);
      const m = members.get(memberId);
      if (!m) return fail('unknown member', { owed: null });
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount', { owed: m.owed });
      if (amount > m.owed) return fail('overpayment', { owed: m.owed });
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = toDay(date);
      advance(day);
      const m = members.get(memberId);
      if (!m) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = memberLoans(memberId).map((l) => ({ bookId: l.bookId, dueDate: fromDay(l.due) }));
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.holds.findIndex((h) => h.memberId === memberId);
        if (idx >= 0) {
          const h = book.holds[idx];
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: h.readyUntil === null ? null : fromDay(h.readyUntil),
          });
        }
      }
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
