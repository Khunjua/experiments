const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_RETURN = 1000;
const BORROW_BLOCK_OWED = 1000;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;

const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
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

const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, queue: [memberId], readyUntil: day|null }
  const books = new Map();
  // memberId -> { owed, loans: [bookId] (borrow order), holds: [bookId] (placement order) }
  const members = new Map();

  function removeHold(memberId, bookId) {
    const m = members.get(memberId);
    if (m) {
      const i = m.holds.indexOf(bookId);
      if (i >= 0) m.holds.splice(i, 1);
    }
  }

  function setAsideNext(book, startDay) {
    if (book.queue.length > 0) book.readyUntil = startDay + PICKUP_DAYS - 1;
    else book.readyUntil = null;
  }

  // Expire pickups that were not collected in time.
  function advance(today) {
    for (const [bookId, book] of books) {
      while (book.readyUntil !== null && today > book.readyUntil) {
        const expired = book.queue.shift();
        removeHold(expired, bookId);
        setAsideNext(book, book.readyUntil + 1);
      }
    }
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
      members.set(memberId, { owed: 0, loans: [], holds: [] });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (b.readyUntil !== null && b.queue[0] !== memberId) return fail('reserved for another member');
      if (m.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
      if (m.loans.length >= MAX_LOANS) return fail('too many loans');
      if (b.readyUntil !== null) {
        b.queue.shift();
        removeHold(memberId, bookId);
        b.readyUntil = null;
      }
      const due = day + LOAN_DAYS;
      b.loan = { memberId, due, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not on loan to member');
      const late = Math.max(0, day - b.loan.due);
      const fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_RETURN);
      m.owed += fine;
      b.loan = null;
      m.loans.splice(m.loans.indexOf(bookId), 1);
      setAsideNext(b, day);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not on loan to member');
      if (b.queue.length > 0) return fail('others waiting');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (day > b.loan.due) return fail('overdue');
      if (m.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
      b.loan.renewals += 1;
      b.loan.due = day + LOAN_DAYS;
      return { ok: true, dueDate: formatDay(b.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan && b.loan.memberId === memberId) return fail('member has the book');
      if (b.queue.includes(memberId)) return fail('already holding');
      if (!b.loan && b.queue.length === 0) return fail('book is available');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > m.owed) return fail('overpayment');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = parseDate(date);
      if (day === null) return fail('invalid date');
      advance(day);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      return {
        loans: m.loans.map((bookId) => ({ bookId, dueDate: formatDay(books.get(bookId).loan.due) })),
        owed: m.owed,
        holds: m.holds.map((bookId) => {
          const b = books.get(bookId);
          const position = b.queue.indexOf(memberId) + 1;
          const readyUntil =
            position === 1 && b.readyUntil !== null ? formatDay(b.readyUntil) : null;
          return { bookId, position, readyUntil };
        }),
      };
    },
  };
}
