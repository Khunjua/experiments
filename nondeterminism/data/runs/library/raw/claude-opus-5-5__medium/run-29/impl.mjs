const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE_PER_LOAN = 1000;
const HOLD_PICKUP_DAYS = 7;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 500;

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

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDay, renewals } | null, holds: [{ memberId, readyUntil: dayNumber|null }] }
  const books = new Map();
  // memberId -> { owed, loanOrder: [bookId] , holdOrder: [bookId] }
  const members = new Map();

  function setAsideNext(book, fromDay) {
    if (book.loan === null && book.holds.length > 0 && book.holds[0].readyUntil === null) {
      book.holds[0].readyUntil = fromDay + HOLD_PICKUP_DAYS - 1;
    }
  }

  function removeHold(bookId, index) {
    const book = books.get(bookId);
    const [h] = book.holds.splice(index, 1);
    const m = members.get(h.memberId);
    if (m) m.holdOrder = m.holdOrder.filter((b) => b !== bookId);
  }

  function processExpirations(day) {
    for (const [bookId, book] of books) {
      while (book.loan === null && book.holds.length > 0) {
        const first = book.holds[0];
        if (first.readyUntil === null) {
          setAsideNext(book, day);
          break;
        }
        if (first.readyUntil >= day) break;
        const expired = first.readyUntil;
        removeHold(bookId, 0);
        setAsideNext(book, expired + 1);
      }
    }
  }

  function prepare(date) {
    const day = parseDate(date);
    if (day === null) return null;
    processExpirations(day);
    return day;
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, holds: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0, loanOrder: [], holdOrder: [] });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m || !book) return fail('unknown member or book');
      if (book.loan) return fail('book on loan');
      if (m.owed >= BORROW_BLOCK_OWED) return fail('too much owed');
      if (m.loanOrder.length >= MAX_LOANS) return fail('loan limit');
      if (book.holds.length > 0) {
        if (book.holds[0].memberId !== memberId) return fail('reserved for another member');
        removeHold(bookId, 0);
      }
      const dueDay = day + LOAN_DAYS;
      book.loan = { memberId, dueDay, renewals: 0 };
      m.loanOrder.push(bookId);
      return { ok: true, dueDate: formatDay(dueDay) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m || !book) return fail('unknown member or book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = day - book.loan.dueDay;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      m.owed += fine;
      book.loan = null;
      m.loanOrder = m.loanOrder.filter((b) => b !== bookId);
      setAsideNext(book, day);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m || !book) return fail('unknown member or book');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not on loan to member');
      if (book.holds.length > 0) return fail('others waiting');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (day > loan.dueDay) return fail('overdue');
      loan.dueDay = day + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.dueDay) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m || !book) return fail('unknown member or book');
      if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
      if (!book.loan && book.holds.length === 0) return fail('book is available');
      if (book.holds.some((h) => h.memberId === memberId)) return fail('already holding');
      book.holds.push({ memberId, readyUntil: null });
      m.holdOrder.push(bookId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const m = members.get(memberId);
      if (!m) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > m.owed) return fail('overpayment');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = prepare(date);
      const m = members.get(memberId);
      if (day === null || !m) return { ok: false, loans: [], owed: 0, holds: [] };
      const loans = m.loanOrder.map((bookId) => ({
        bookId,
        dueDate: formatDay(books.get(bookId).loan.dueDay),
      }));
      const holds = m.holdOrder.map((bookId) => {
        const book = books.get(bookId);
        const idx = book.holds.findIndex((h) => h.memberId === memberId);
        const h = book.holds[idx];
        return {
          bookId,
          position: idx + 1,
          readyUntil: h.readyUntil === null ? null : formatDay(h.readyUntil),
        };
      });
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
