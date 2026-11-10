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

function formatDate(n) {
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
  // bookId -> { loan: {memberId, due, renewals} | null, holds: [memberId], setAside: {memberId, readyUntil} | null }
  const books = new Map();
  // memberId -> { owed, loans: Set<bookId> }
  const members = new Map();

  const LOAN_DAYS = 21;
  const MAX_LOANS = 5;
  const OWED_LIMIT = 1000;
  const FINE_PER_DAY = 25;
  const GRACE_DAYS = 2;
  const FINE_CAP = 500;
  const MAX_RENEWALS = 2;
  const HOLD_DAYS = 3;

  function processExpiry(day) {
    if (day === null) return;
    for (const book of books.values()) {
      while (book.setAside && day > book.setAside.readyUntil) {
        const oldUntil = book.setAside.readyUntil;
        book.holds.shift();
        if (book.holds.length > 0) {
          book.setAside = { memberId: book.holds[0], readyUntil: oldUntil + HOLD_DAYS };
        } else {
          book.setAside = null;
        }
      }
    }
  }

  function fail(reason, extra) {
    return Object.assign({ ok: false, reason }, extra || {});
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, holds: [], setAside: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date', { dueDate: null });
      processExpiry(day);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member', { dueDate: null });
      if (!book) return fail('unknown book', { dueDate: null });
      if (book.loan) return fail('book on loan', { dueDate: null });
      if (book.setAside && book.setAside.memberId !== memberId) return fail('book set aside', { dueDate: null });
      if (member.loans.size >= MAX_LOANS) return fail('loan limit', { dueDate: null });
      if (member.owed >= OWED_LIMIT) return fail('owes too much', { dueDate: null });
      if (book.setAside) {
        book.holds.shift();
        book.setAside = null;
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      member.loans.add(bookId);
      return { ok: true, dueDate: formatDate(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date', { fine: 0 });
      processExpiry(day);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to member', { fine: 0 });
      }
      const late = day - book.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      member.loans.delete(bookId);
      book.loan = null;
      if (book.holds.length > 0) {
        book.setAside = { memberId: book.holds[0], readyUntil: day + HOLD_DAYS };
      } else {
        book.setAside = null;
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date', { dueDate: null });
      processExpiry(day);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to member', { dueDate: null });
      }
      const loan = book.loan;
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit', { dueDate: null });
      if (book.holds.length > 0) return fail('book has holds', { dueDate: null });
      if (day > loan.due) return fail('overdue', { dueDate: null });
      loan.due += LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date', { position: null });
      processExpiry(day);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member', { position: null });
      if (!book) return fail('unknown book', { position: null });
      if (!book.loan && !book.setAside) return fail('book is on shelf', { position: null });
      if (book.loan && book.loan.memberId === memberId) return fail('member has book', { position: null });
      if (book.holds.includes(memberId)) return fail('already holding', { position: null });
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = parseDate(date);
      if (day !== null) processExpiry(day);
      const member = members.get(memberId);
      if (!member) return fail('unknown member', { owed: 0 });
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return fail('invalid amount', { owed: member.owed });
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = parseDate(date);
      if (day !== null) processExpiry(day);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = [];
      for (const bookId of member.loans) {
        loans.push({ bookId, dueDate: formatDate(books.get(bookId).loan.due) });
      }
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.holds.indexOf(memberId);
        if (idx === -1) continue;
        const readyUntil =
          book.setAside && book.setAside.memberId === memberId ? formatDate(book.setAside.readyUntil) : null;
        holds.push({ bookId, position: idx + 1, readyUntil });
      }
      return { loans, owed: member.owed, holds };
    },
  };
}
