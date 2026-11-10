const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE_PER_LOAN = 500;
const BLOCK_OWED = 1000;
const MAX_LOANS = 5;
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
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals} | null, holds: [memberId], readyUntil: dayNum|null }
  const members = new Map(); // memberId -> { owed }
  let lastDay = null;

  const fail = (reason) => ({ ok: false, reason });

  function advance(day) {
    if (lastDay !== null && day < lastDay) return false;
    lastDay = day;
    for (const book of books.values()) {
      while (!book.loan && book.readyUntil !== null && day > book.readyUntil) {
        const prev = book.readyUntil;
        book.holds.shift();
        book.readyUntil = book.holds.length > 0 ? prev + PICKUP_DAYS : null;
      }
    }
    return true;
  }

  function begin(date) {
    const day = parseDate(date);
    if (day === null) return null;
    if (!advance(day)) return null;
    return day;
  }

  function loanCount(memberId) {
    let n = 0;
    for (const b of books.values()) if (b.loan && b.loan.memberId === memberId) n++;
    return n;
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId) || books.has(bookId)) return fail('invalid or duplicate book');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId) || members.has(memberId)) return fail('invalid or duplicate member');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const day = begin(date);
      if (day === null) return fail('bad date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (book.loan) return fail('book is out');
      if (book.readyUntil !== null && book.holds[0] !== memberId) return fail('set aside for another member');
      if (member.owed >= BLOCK_OWED) return fail('too much owed');
      if (loanCount(memberId) >= MAX_LOANS) return fail('loan limit');
      if (book.readyUntil !== null) {
        book.holds.shift();
        book.readyUntil = null;
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = begin(date);
      if (day === null) return fail('bad date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = day - book.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      member.owed += fine;
      book.loan = null;
      book.readyUntil = book.holds.length > 0 ? day + PICKUP_DAYS : null;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = begin(date);
      if (day === null) return fail('bad date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      if (book.holds.length > 0) return fail('others waiting');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (day > book.loan.due) return fail('overdue');
      if (member.owed >= BLOCK_OWED) return fail('too much owed');
      book.loan.renewals++;
      book.loan.due += LOAN_DAYS;
      return { ok: true, dueDate: formatDay(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = begin(date);
      if (day === null) return fail('bad date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan && book.readyUntil === null) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
      if (book.holds.includes(memberId)) return fail('already holding');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = begin(date);
      if (day === null) return fail('bad date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) return fail('bad amount');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = begin(date);
      if (day === null) return fail('bad date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: formatDay(book.loan.due) });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          const ready = !book.loan && book.readyUntil !== null && idx === 0;
          holds.push({ bookId, position: idx + 1, readyUntil: ready ? formatDay(book.readyUntil) : null });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
