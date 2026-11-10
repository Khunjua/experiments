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

function addDays(s, n) {
  return formatDay(parseDate(s) + n);
}

function daysBetween(a, b) {
  return parseDate(b) - parseDate(a);
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
  const books = new Map();   // bookId -> { loan, holds: [], setAside }
  const members = new Map(); // memberId -> { owed, loans: Set }

  const fail = (reason) => ({ ok: false, reason });

  function advance(date) {
    const today = parseDate(date);
    for (const book of books.values()) {
      while (book.setAside && today > parseDate(book.setAside.readyUntil)) {
        const oldUntil = book.setAside.readyUntil;
        book.holds.shift();
        if (book.holds.length > 0) {
          book.setAside = { memberId: book.holds[0], readyUntil: addDays(oldUntil, HOLD_DAYS) };
        } else {
          book.setAside = null;
        }
      }
    }
  }

  function prepare(memberId, bookId, date) {
    if (parseDate(date) === null) return { err: fail('invalid date') };
    advance(date);
    const member = members.get(memberId);
    if (!member) return { err: fail('unknown member') };
    let book = null;
    if (bookId !== undefined) {
      book = books.get(bookId);
      if (!book) return { err: fail('unknown book') };
    }
    return { member, book };
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid or duplicate book');
      books.set(bookId, { loan: null, holds: [], setAside: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid or duplicate member');
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const { err, member, book } = prepare(memberId, bookId, date);
      if (err) return err;
      if (book.loan) return fail('book on loan');
      if (book.setAside && book.setAside.memberId !== memberId) return fail('set aside for another member');
      if (member.loans.size >= MAX_LOANS) return fail('loan limit');
      if (member.owed >= OWED_LIMIT) return fail('owes too much');
      if (book.setAside) {
        book.holds.shift();
        book.setAside = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      member.loans.add(bookId);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const { err, member, book } = prepare(memberId, bookId, date);
      if (err) return err;
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = daysBetween(book.loan.dueDate, date);
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      member.loans.delete(bookId);
      book.loan = null;
      if (book.holds.length > 0) {
        book.setAside = { memberId: book.holds[0], readyUntil: addDays(date, HOLD_DAYS) };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const { err, book } = prepare(memberId, bookId, date);
      if (err) return err;
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      if (parseDate(date) > parseDate(book.loan.dueDate)) return fail('overdue');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.holds.length > 0) return fail('book has holds');
      book.loan.dueDate = addDays(book.loan.dueDate, LOAN_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const { err, book } = prepare(memberId, bookId, date);
      if (err) return err;
      if (!book.loan && !book.setAside) return fail('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
      if (book.holds.includes(memberId)) return fail('already holding');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const { err, member } = prepare(memberId, undefined, date);
      if (err) return err;
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) return fail('invalid amount');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      if (date !== undefined) {
        if (parseDate(date) === null) return { ok: false, reason: 'invalid date', loans: [], owed: 0, holds: [] };
        advance(date);
      }
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
          const readyUntil =
            book.setAside && book.setAside.memberId === memberId ? book.setAside.readyUntil : null;
          holds.push({ bookId, position: idx + 1, readyUntil });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
