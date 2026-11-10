const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function fmtDate(n) {
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
  // bookId -> { loan: { memberId, due, renewals } | null, holds: [memberId], readyUntil: number|null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function fail(reason) {
    return { ok: false, reason };
  }

  // Process expired set-asides up to (and excluding) day `today`.
  function advance(today) {
    for (const book of books.values()) {
      if (book.loan) continue;
      while (book.readyUntil !== null && book.readyUntil < today) {
        book.holds.shift();
        if (book.holds.length > 0) {
          book.readyUntil += HOLD_DAYS;
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

  function prepare(memberId, bookId, date) {
    const today = parseDate(date);
    if (today === null) return { err: 'invalid date' };
    advance(today);
    if (!members.has(memberId)) return { err: 'unknown member' };
    if (bookId !== undefined && !books.has(bookId)) return { err: 'unknown book' };
    return { today, member: members.get(memberId), book: bookId !== undefined ? books.get(bookId) : null };
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
      if (bookId === undefined) return fail('unknown book');
      const p = prepare(memberId, bookId, date);
      if (p.err) return fail(p.err);
      const { today, member, book } = p;
      if (book.loan) return fail('on loan');
      if (book.readyUntil !== null && book.holds[0] !== memberId) return fail('set aside for another member');
      if (loanCount(memberId) >= MAX_LOANS) return fail('loan limit');
      if (member.owed >= OWED_LIMIT) return fail('owes too much');
      if (book.readyUntil !== null) {
        book.holds.shift();
        book.readyUntil = null;
      }
      const due = today + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      return { ok: true, dueDate: fmtDate(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (bookId === undefined) return fail('unknown book');
      const p = prepare(memberId, bookId, date);
      if (p.err) return fail(p.err);
      const { today, member, book } = p;
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = today - book.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      book.loan = null;
      book.readyUntil = book.holds.length > 0 ? today + HOLD_DAYS : null;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (bookId === undefined) return fail('unknown book');
      const p = prepare(memberId, bookId, date);
      if (p.err) return fail(p.err);
      const { today, book } = p;
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.holds.length > 0) return fail('book has holds');
      if (today > book.loan.due) return fail('overdue');
      book.loan.due += LOAN_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: fmtDate(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (bookId === undefined) return fail('unknown book');
      const p = prepare(memberId, bookId, date);
      if (p.err) return fail(p.err);
      const { book } = p;
      if (!book.loan && book.readyUntil === null) return fail('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('member has it on loan');
      if (book.holds.includes(memberId)) return fail('already held');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const p = prepare(memberId, undefined, date);
      if (p.err) return fail(p.err);
      const { member } = p;
      if (typeof amount !== 'number' || !Number.isInteger(amount)) return fail('invalid amount');
      if (amount <= 0) return fail('amount must be positive');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      if (date !== undefined) {
        const today = parseDate(date);
        if (today === null) return fail('invalid date');
        advance(today);
      }
      if (!members.has(memberId)) return fail('unknown member');
      const member = members.get(memberId);
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: fmtDate(book.loan.due) });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          const setAside = idx === 0 && !book.loan && book.readyUntil !== null;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAside ? fmtDate(book.readyUntil) : null,
          });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
