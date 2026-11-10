const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const GRACE_DAYS = 0;
const PICKUP_DAYS = 7;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

function fmt(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals} | null, queue: [memberId], readyUntil: day|null }
  const members = new Map(); // memberId -> { owed, loans: [bookId] (in borrow order) }

  const fail = (reason) => ({ ok: false, reason });

  function advanceBook(book, today) {
    // Expire set-aside holds whose pickup window has passed.
    while (!book.loan && book.queue.length > 0 && book.readyUntil !== null && book.readyUntil < today) {
      const last = book.readyUntil;
      book.queue.shift();
      if (book.queue.length > 0) {
        book.readyUntil = last + PICKUP_DAYS;
      } else {
        book.readyUntil = null;
      }
    }
  }

  function advanceAll(today) {
    for (const b of books.values()) advanceBook(b, today);
  }

  function computeFine(due, returned) {
    const late = returned - due - GRACE_DAYS;
    if (late <= 0) return 0;
    return Math.min((returned - due) * FINE_PER_DAY, MAX_FINE_PER_LOAN);
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid id');
      if (books.has(bookId)) return fail('duplicate');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid id');
      if (members.has(memberId)) return fail('duplicate');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      advanceAll(today);
      if (b.loan) return fail('on loan');
      if (b.queue.length > 0 && b.queue[0] !== memberId) return fail('set aside for another member');
      if (m.loans.length >= MAX_LOANS) return fail('loan limit');
      if (m.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
      if (b.queue.length > 0 && b.queue[0] === memberId) {
        b.queue.shift();
      }
      b.readyUntil = null;
      const due = today + LOAN_DAYS;
      b.loan = { memberId, due, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate: fmt(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      advanceAll(today);
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed by member');
      const fine = computeFine(b.loan.due, today);
      m.owed += fine;
      m.loans = m.loans.filter((id) => id !== bookId);
      b.loan = null;
      b.readyUntil = b.queue.length > 0 ? today + PICKUP_DAYS : null;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      advanceAll(today);
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed by member');
      if (b.queue.length > 0) return fail('others waiting');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (today > b.loan.due) return fail('overdue');
      if (m.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
      b.loan.due = Math.max(b.loan.due, today + LOAN_DAYS);
      b.loan.renewals += 1;
      return { ok: true, dueDate: fmt(b.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      advanceAll(today);
      if (!b.loan && b.queue.length === 0) return fail('book is available');
      if (b.loan && b.loan.memberId === memberId) return fail('member has the book');
      if (b.queue.includes(memberId)) return fail('already holding');
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      advanceAll(today);
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > m.owed) return fail('overpayment');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      const today = parseDate(date);
      const m = members.get(memberId);
      if (today === null || !m) return { ok: false, loans: [], owed: 0, holds: [] };
      advanceAll(today);
      const loans = m.loans.map((bookId) => ({ bookId, dueDate: fmt(books.get(bookId).loan.due) }));
      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.indexOf(memberId);
        if (idx === -1) continue;
        const setAside = idx === 0 && !b.loan && b.readyUntil !== null;
        holds.push({ bookId, position: idx + 1, readyUntil: setAside ? fmt(b.readyUntil) : null });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
