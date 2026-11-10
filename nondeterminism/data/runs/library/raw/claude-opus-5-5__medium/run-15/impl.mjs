const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 1000;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return t;
}

function fmt(t) {
  return new Date(t).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fmt(parseDate(s) + n * DAY_MS);
}

function diffDays(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / DAY_MS);
}

function validId(id) {
  return typeof id === 'string' && id.length > 0;
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  const fail = (reason) => ({ ok: false, reason });

  function processBook(book, date) {
    while (!book.loan && book.queue.length > 0 && book.readyUntil !== null && book.readyUntil < date) {
      const expired = book.queue.shift();
      const m = members.get(expired);
      if (m) m.holds = m.holds.filter((b) => b !== book.id);
      const old = book.readyUntil;
      book.readyUntil = book.queue.length > 0 ? addDays(old, 1 + PICKUP_DAYS) : null;
    }
  }

  function processAll(date) {
    for (const b of books.values()) processBook(b, date);
  }

  function owedOf(m) {
    return m.owed;
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('duplicate book');
      books.set(bookId, { id: bookId, loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('duplicate member');
      members.set(memberId, { id: memberId, loans: [], holds: [], owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m) return fail('unknown member');
      if (!b) return fail('unknown book');
      processAll(date);
      if (b.loan) return fail('book is on loan');
      if (b.queue.length > 0 && b.queue[0] !== memberId) return fail('book is set aside for another member');
      if (m.loans.length >= MAX_LOANS) return fail('too many loans');
      if (owedOf(m) >= BORROW_BLOCK_OWED) return fail('too much owed');
      if (b.queue.length > 0) {
        b.queue.shift();
        m.holds = m.holds.filter((x) => x !== bookId);
        b.readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m) return fail('unknown member');
      if (!b) return fail('unknown book');
      processAll(date);
      if (!b.loan || b.loan.memberId !== memberId) return fail('not on loan to this member');
      const late = diffDays(b.loan.dueDate, date);
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      m.owed += fine;
      b.loan = null;
      m.loans = m.loans.filter((x) => x !== bookId);
      b.readyUntil = b.queue.length > 0 ? addDays(date, PICKUP_DAYS) : null;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m) return fail('unknown member');
      if (!b) return fail('unknown book');
      processAll(date);
      if (!b.loan || b.loan.memberId !== memberId) return fail('not on loan to this member');
      if (b.queue.length > 0) return fail('others are waiting');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (date > b.loan.dueDate) return fail('loan is overdue');
      b.loan.dueDate = addDays(b.loan.dueDate, LOAN_DAYS);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m) return fail('unknown member');
      if (!b) return fail('unknown book');
      processAll(date);
      if (b.loan && b.loan.memberId === memberId) return fail('member has this book');
      if (b.queue.includes(memberId)) return fail('already holding');
      if (!b.loan && b.queue.length === 0) return fail('book is available; borrow it');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      if (parseDate(date) === null) return fail('invalid date');
      const m = members.get(memberId);
      if (!m) return fail('unknown member');
      processAll(date);
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > m.owed) return fail('amount exceeds owed');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      const m = members.get(memberId);
      if (!m) return fail('unknown member');
      if (parseDate(date) !== null) processAll(date);
      const loans = m.loans.map((bookId) => ({ bookId, dueDate: books.get(bookId).loan.dueDate }));
      const holds = m.holds.map((bookId) => {
        const b = books.get(bookId);
        const idx = b.queue.indexOf(memberId);
        return {
          bookId,
          position: idx + 1,
          readyUntil: !b.loan && idx === 0 ? b.readyUntil : null,
        };
      });
      return { loans, owed: m.owed, holds };
    },
  };
}
