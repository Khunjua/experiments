const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_PICKUP_DAYS = 3;
const MS_PER_DAY = 86400000;

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / MS_PER_DAY);
}

function formatDay(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function isValidId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

export function createLibrary() {
  // bookId -> { loan: {memberId, due, renewals} | null, holds: [memberId], setAside: {memberId, until} | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function settle(day) {
    for (const book of books.values()) {
      while (book.setAside && day > book.setAside.until) {
        const oldUntil = book.setAside.until;
        const idx = book.holds.indexOf(book.setAside.memberId);
        if (idx !== -1) book.holds.splice(idx, 1);
        if (book.holds.length > 0) {
          book.setAside = { memberId: book.holds[0], until: oldUntil + HOLD_PICKUP_DAYS };
        } else {
          book.setAside = null;
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

  function prepare(memberId, date) {
    const day = parseDate(date);
    if (day === null) return null;
    settle(day);
    if (!members.has(memberId)) return null;
    return day;
  }

  return {
    addBook({ bookId } = {}) {
      if (!isValidId(bookId) || books.has(bookId)) return { ok: false, reason: 'invalid or duplicate book' };
      books.set(bookId, { loan: null, holds: [], setAside: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!isValidId(memberId) || members.has(memberId)) return { ok: false, reason: 'invalid or duplicate member' };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const day = prepare(memberId, date);
      if (day === null) return { ok: false, reason: 'invalid member or date' };
      const book = books.get(bookId);
      if (!book) return { ok: false, reason: 'unknown book' };
      const member = members.get(memberId);
      if (book.loan) return { ok: false, reason: 'book on loan' };
      if (book.setAside && book.setAside.memberId !== memberId) return { ok: false, reason: 'set aside for another member' };
      if (member.owed >= BORROW_BLOCK_OWED) return { ok: false, reason: 'owes too much' };
      if (loanCount(memberId) >= MAX_LOANS) return { ok: false, reason: 'loan limit' };
      if (book.setAside && book.setAside.memberId === memberId) {
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) book.holds.splice(idx, 1);
        book.setAside = null;
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = prepare(memberId, date);
      if (day === null) return { ok: false, fine: 0, reason: 'invalid member or date' };
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false, fine: 0, reason: 'not on loan to member' };
      }
      const late = day - book.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      members.get(memberId).owed += fine;
      book.loan = null;
      if (book.holds.length > 0) {
        book.setAside = { memberId: book.holds[0], until: day + HOLD_PICKUP_DAYS };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = prepare(memberId, date);
      if (day === null) return { ok: false, reason: 'invalid member or date' };
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) return { ok: false, reason: 'not on loan to member' };
      if (book.loan.renewals >= MAX_RENEWALS) return { ok: false, reason: 'renewal limit' };
      if (book.holds.length > 0) return { ok: false, reason: 'book has holds' };
      if (day > book.loan.due) return { ok: false, reason: 'overdue' };
      book.loan.due += LOAN_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: formatDay(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = prepare(memberId, date);
      if (day === null) return { ok: false, reason: 'invalid member or date' };
      const book = books.get(bookId);
      if (!book) return { ok: false, reason: 'unknown book' };
      if (!book.loan && !book.setAside) return { ok: false, reason: 'book is on the shelf' };
      if (book.loan && book.loan.memberId === memberId) return { ok: false, reason: 'member has book on loan' };
      if (book.holds.includes(memberId)) return { ok: false, reason: 'already holding' };
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = prepare(memberId, date);
      if (day === null) return { ok: false, reason: 'invalid member or date' };
      const member = members.get(memberId);
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false, owed: member.owed, reason: 'invalid amount' };
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = prepare(memberId, date);
      if (day === null) return { ok: false, loans: [], owed: 0, holds: [], reason: 'invalid member or date' };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: formatDay(book.loan.due) });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          const readyUntil =
            book.setAside && book.setAside.memberId === memberId ? formatDay(book.setAside.until) : null;
          holds.push({ bookId, position: idx + 1, readyUntil });
        }
      }
      return { ok: true, loans, owed: members.get(memberId).owed, holds };
    },
  };
}
