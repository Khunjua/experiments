const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 500;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;

const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
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

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals} | null, holds: [memberId], readyUntil: day|null }
  const members = new Map(); // memberId -> { owed, loans: [bookId] }

  function fail(reason) {
    return { ok: false, reason };
  }

  function advance(today) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && today > book.readyUntil) {
        const prev = book.readyUntil;
        book.holds.shift();
        book.readyUntil = book.holds.length > 0 ? prev + 1 + PICKUP_DAYS : null;
      }
    }
  }

  function prep(memberId, bookId, date, needBook = true) {
    const today = parseDate(date);
    if (today === null) return { err: 'invalid date' };
    advance(today);
    const member = members.get(memberId);
    if (!member) return { err: 'unknown member' };
    let book = null;
    if (needBook) {
      book = books.get(bookId);
      if (!book) return { err: 'unknown book' };
    }
    return { today, member, book };
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid id');
      if (books.has(bookId)) return fail('duplicate book');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid id');
      if (members.has(memberId)) return fail('duplicate member');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId, date);
      if (p.err) return fail(p.err);
      const { today, member, book } = p;
      if (book.loan) return fail('book is on loan');
      if (member.owed >= BORROW_BLOCK_OWED) return fail('too much owed');
      if (book.readyUntil !== null) {
        if (book.holds[0] !== memberId) return fail('book is set aside for another member');
        book.holds.shift();
        book.readyUntil = null;
      } else if (book.holds.length > 0) {
        return fail('book has holds');
      }
      const due = today + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      member.loans.push(bookId);
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId, date);
      if (p.err) return fail(p.err);
      const { today, member, book } = p;
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to this member');
      const lateDays = Math.max(0, today - book.loan.due);
      const fine = Math.min(lateDays * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      member.owed += fine;
      member.loans = member.loans.filter((b) => b !== bookId);
      book.loan = null;
      if (book.holds.length > 0) book.readyUntil = today + PICKUP_DAYS;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId, date);
      if (p.err) return fail(p.err);
      const { today, member, book } = p;
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to this member');
      if (book.holds.length > 0) return fail('others are waiting');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (today > book.loan.due) return fail('loan is overdue');
      if (member.owed >= BORROW_BLOCK_OWED) return fail('too much owed');
      book.loan.renewals += 1;
      book.loan.due = Math.max(book.loan.due, today + LOAN_DAYS);
      return { ok: true, dueDate: formatDay(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId, date);
      if (p.err) return fail(p.err);
      const { book } = p;
      if (!book.loan && book.readyUntil === null) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
      if (book.holds.includes(memberId)) return fail('already holding');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const p = prep(memberId, null, date, false);
      if (p.err) return fail(p.err);
      const { member } = p;
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('amount exceeds owed');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const p = prep(memberId, null, date, false);
      if (p.err) return fail(p.err);
      const { member } = p;
      const loans = member.loans.map((bookId) => ({
        bookId,
        dueDate: formatDay(books.get(bookId).loan.due),
      }));
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.holds.indexOf(memberId);
        if (idx === -1) continue;
        holds.push({
          bookId,
          position: idx + 1,
          readyUntil: idx === 0 && book.readyUntil !== null ? formatDay(book.readyUntil) : null,
        });
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
