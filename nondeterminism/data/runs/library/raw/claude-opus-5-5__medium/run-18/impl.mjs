const DAY_MS = 24 * 60 * 60 * 1000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP_PER_LOAN = 500;
const BLOCK_THRESHOLD = 1000;
const PICKUP_DAYS = 7;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function formatDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function isId(x) {
  return (typeof x === 'string' && x.length > 0) || (typeof x === 'number' && Number.isFinite(x));
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { loan: {memberId, due, renewals, seq} | null, holds: [{memberId, readyUntil(day|null)}] }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();
  let seq = 0;
  let lastDay = null;

  function processExpiries(today) {
    for (const book of books.values()) {
      while (book.holds.length > 0 && book.holds[0].readyUntil !== null && today > book.holds[0].readyUntil) {
        const expired = book.holds.shift();
        if (book.holds.length > 0) {
          const start = expired.readyUntil + 1;
          book.holds[0].readyUntil = start + PICKUP_DAYS;
        }
      }
    }
  }

  function prepare(date) {
    const day = parseDate(date);
    if (day === null) return null;
    if (lastDay !== null && day < lastDay) return null;
    lastDay = day;
    processExpiries(day);
    return day;
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
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (member.owed >= BLOCK_THRESHOLD) return fail('too much owed');
      if (book.loan) return fail('book is out');
      if (book.holds.length > 0) {
        const first = book.holds[0];
        if (first.memberId !== memberId || first.readyUntil === null) return fail('book reserved for another member');
        book.holds.shift();
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0, seq: seq++ };
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by member');
      const late = Math.max(0, day - book.loan.due);
      const fine = Math.min(late * FINE_PER_DAY, FINE_CAP_PER_LOAN);
      member.owed += fine;
      book.loan = null;
      if (book.holds.length > 0) {
        book.holds[0].readyUntil = day + PICKUP_DAYS;
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not borrowed by member');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.holds.length > 0) return fail('others are waiting');
      if (day > loan.due) return fail('overdue');
      if (member.owed >= BLOCK_THRESHOLD) return fail('too much owed');
      loan.renewals += 1;
      loan.due += LOAN_DAYS;
      return { ok: true, dueDate: formatDay(loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (member.owed >= BLOCK_THRESHOLD) return fail('too much owed');
      if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
      if (book.holds.some(h => h.memberId === memberId)) return fail('already holding');
      if (!book.loan && book.holds.length === 0) return fail('book is available');
      book.holds.push({ memberId, readyUntil: null });
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('amount exceeds owed');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = prepare(date);
      const member = members.get(memberId);
      if (day === null || !member) return { ok: false, loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: formatDay(book.loan.due), _seq: book.loan.seq });
        }
        const idx = book.holds.findIndex(h => h.memberId === memberId);
        if (idx >= 0) {
          const h = book.holds[idx];
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: h.readyUntil === null ? null : formatDay(h.readyUntil),
          });
        }
      }
      loans.sort((a, b) => a._seq - b._seq);
      return {
        ok: true,
        loans: loans.map(({ bookId, dueDate }) => ({ bookId, dueDate })),
        owed: member.owed,
        holds,
      };
    },
  };
}
