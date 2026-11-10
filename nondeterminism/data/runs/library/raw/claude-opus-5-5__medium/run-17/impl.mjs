const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE_PER_LOAN = 1000;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const HOLD_PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDay(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

function fromDay(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, holds: [memberId], readyUntil: dayNumber | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function processExpiries(today) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && today > book.readyUntil) {
        const expiredAt = book.readyUntil;
        book.holds.shift();
        book.readyUntil = book.holds.length > 0 ? expiredAt + HOLD_PICKUP_DAYS : null;
      }
    }
  }

  function prep(date) {
    const day = toDay(date);
    if (day === null) return null;
    processExpiries(day);
    return day;
  }

  function loansOf(memberId) {
    const out = [];
    for (const [bookId, b] of books) {
      if (b.loan && b.loan.memberId === memberId) out.push([bookId, b]);
    }
    return out;
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
      const day = prep(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book on loan');
      if (member.owed >= BORROW_BLOCK_OWED) return fail('too much owed');
      if (loansOf(memberId).length >= MAX_LOANS) return fail('loan limit');
      if (book.readyUntil !== null) {
        if (book.holds[0] !== memberId) return fail('book set aside for another member');
        book.holds.shift();
        book.readyUntil = null;
      } else if (book.holds.length > 0) {
        return fail('book has holds');
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      return { ok: true, dueDate: fromDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = day - book.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      member.owed += fine;
      book.loan = null;
      if (book.holds.length > 0) book.readyUntil = day + HOLD_PICKUP_DAYS;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not on loan to member');
      if (day > loan.due) return fail('overdue');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.holds.length > 0) return fail('others waiting');
      loan.due = day + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: fromDay(loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
      if (book.holds.includes(memberId)) return fail('already holding');
      if (!book.loan && book.holds.length === 0) return fail('book is available');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const loans = loansOf(memberId).map(([bookId, b]) => ({ bookId, dueDate: fromDay(b.loan.due) }));
      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.holds.indexOf(memberId);
        if (idx === -1) continue;
        holds.push({
          bookId,
          position: idx + 1,
          readyUntil: idx === 0 && b.readyUntil !== null ? fromDay(b.readyUntil) : null,
        });
      }
      return { loans, owed: member.owed, holds };
    },
  };
}
