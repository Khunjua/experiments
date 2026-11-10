const MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime();
}

function fmt(ms) {
  const dt = new Date(ms);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return fmt(parseDate(s) + n * MS);
}

const validId = (x) => typeof x === 'string' && x.length > 0;
const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { borrower, queue: [], readyUntil }
  const members = new Map(); // memberId -> { loans: [], owed, holds: [] }
  let current = null;

  function expire(date) {
    for (const [bookId, b] of books) {
      while (b.borrower === null && b.queue.length > 0 && date > b.readyUntil) {
        const gone = b.queue.shift();
        const mem = members.get(gone);
        const i = mem.holds.indexOf(bookId);
        if (i >= 0) mem.holds.splice(i, 1);
        if (b.queue.length > 0) b.readyUntil = addDays(b.readyUntil, 8);
        else b.readyUntil = null;
      }
    }
  }

  // Returns null on ok (clock advanced, expiry run), else a failure.
  function tick(args) {
    if (args === null || typeof args !== 'object') return FAIL('args');
    const date = args.date;
    if (parseDate(date) === null) return FAIL('date');
    if (current !== null && date < current) return FAIL('past');
    current = date;
    expire(date);
    return null;
  }

  return {
    addBook(a) {
      if (!a || typeof a !== 'object' || !validId(a.bookId)) return FAIL('id');
      if (books.has(a.bookId)) return FAIL('exists');
      books.set(a.bookId, { borrower: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(a) {
      if (!a || typeof a !== 'object' || !validId(a.memberId)) return FAIL('id');
      if (members.has(a.memberId)) return FAIL('exists');
      members.set(a.memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },
    borrow(a) {
      const f = tick(a); if (f) return f;
      const { memberId, bookId, date } = a;
      if (!validId(memberId) || !validId(bookId)) return FAIL('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.borrower !== null) return FAIL('on loan');
      if (b.queue.length > 0 && b.queue[0] !== memberId) return FAIL('set aside');
      if (m.loans.length >= 5) return FAIL('limit');
      if (m.loans.some((l) => l.dueDate < date)) return FAIL('overdue');
      if (m.owed >= 1000) return FAIL('owed');
      if (b.queue.length > 0) {
        b.queue.shift();
        b.readyUntil = null;
        const i = m.holds.indexOf(bookId);
        if (i >= 0) m.holds.splice(i, 1);
        if (b.queue.length > 0) {
          // book is on loan now; queue just waits
        }
      }
      const dueDate = addDays(date, 21);
      b.borrower = memberId;
      m.loans.push({ bookId, dueDate, renewals: 0 });
      return { ok: true, dueDate };
    },
    returnBook(a) {
      const f = tick(a); if (f) return f;
      const { memberId, bookId, date } = a;
      if (!validId(memberId) || !validId(bookId)) return FAIL('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.borrower !== memberId) return FAIL('not borrowed');
      const idx = m.loans.findIndex((l) => l.bookId === bookId);
      const loan = m.loans[idx];
      const daysLate = Math.max(0, Math.round((parseDate(date) - parseDate(loan.dueDate)) / MS));
      const fine = Math.min(500, 25 * Math.max(0, daysLate - 2));
      m.owed += fine;
      m.loans.splice(idx, 1);
      b.borrower = null;
      b.readyUntil = b.queue.length > 0 ? addDays(date, 7) : null;
      return { ok: true, fine };
    },
    renew(a) {
      const f = tick(a); if (f) return f;
      const { memberId, bookId, date } = a;
      if (!validId(memberId) || !validId(bookId)) return FAIL('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.borrower !== memberId) return FAIL('not borrowed');
      const loan = m.loans.find((l) => l.bookId === bookId);
      if (loan.renewals >= 2) return FAIL('max renewals');
      if (date > loan.dueDate) return FAIL('overdue');
      if (b.queue.length > 0) return FAIL('holds');
      loan.dueDate = addDays(date, 21);
      loan.renewals++;
      return { ok: true, dueDate: loan.dueDate };
    },
    placeHold(a) {
      const f = tick(a); if (f) return f;
      const { memberId, bookId } = a;
      if (!validId(memberId) || !validId(bookId)) return FAIL('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.borrower === null && b.queue.length === 0) return FAIL('available');
      if (b.borrower === memberId) return FAIL('own loan');
      if (b.queue.includes(memberId)) return FAIL('duplicate');
      if (m.holds.length >= 5) return FAIL('limit');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(a) {
      const f = tick(a); if (f) return f;
      const { memberId, amount } = a;
      if (!validId(memberId)) return FAIL('id');
      if (!Number.isSafeInteger(amount) || amount <= 0) return FAIL('amount');
      const m = members.get(memberId);
      if (!m) return FAIL('unknown');
      if (amount > m.owed) return FAIL('overpay');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember(a) {
      const f = tick(a); if (f) return f;
      const { memberId } = a;
      if (!validId(memberId)) return FAIL('id');
      const m = members.get(memberId);
      if (!m) return FAIL('unknown');
      return {
        ok: true,
        loans: m.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate })),
        owed: m.owed,
        holds: m.holds.map((bookId) => {
          const b = books.get(bookId);
          const pos = b.queue.indexOf(memberId);
          return {
            bookId,
            position: pos + 1,
            readyUntil: pos === 0 && b.borrower === null ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
