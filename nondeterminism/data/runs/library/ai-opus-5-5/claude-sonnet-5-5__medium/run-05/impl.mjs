const DAY = 86400000;
const RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  if (typeof s !== 'string' || !RE.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(dt.getTime() / DAY);
}

function fmt(n) {
  const dt = new Date(n * DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return fmt(parseDate(s) + n);
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;
  const FAIL = { ok: false };
  const fail = () => ({ ok: false });

  function removeHold(memberId, bookId) {
    const m = members.get(memberId);
    if (!m) return;
    const i = m.holds.indexOf(bookId);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function expire(date) {
    for (const [bookId, b] of books) {
      if (b.state !== 'aside') continue;
      while (b.state === 'aside' && date > b.readyUntil) {
        const gone = b.queue.shift();
        removeHold(gone, bookId);
        if (b.queue.length > 0) {
          b.readyUntil = addDays(b.readyUntil, 8);
        } else {
          b.state = 'available';
          b.readyUntil = null;
        }
      }
    }
  }

  // Returns date string if call may proceed, else null.
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const d = args.date;
    if (parseDate(d) === null) return null;
    if (current !== null && d < current) return null;
    current = d;
    expire(d);
    return d;
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return fail();
      const { bookId } = args;
      if (!validId(bookId) || books.has(bookId)) return fail();
      books.set(bookId, { state: 'available', holder: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      if (args === null || typeof args !== 'object') return fail();
      const { memberId } = args;
      if (!validId(memberId) || members.has(memberId)) return fail();
      members.set(memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },

    borrow(args) {
      const date = begin(args);
      if (date === null) return fail();
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail();
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail();
      if (b.state === 'loan') return fail();
      if (b.state === 'aside' && b.queue[0] !== memberId) return fail();
      if (m.loans.length >= 5) return fail();
      if (m.loans.some(l => l.dueDate < date)) return fail();
      if (m.owed >= 1000) return fail();
      if (b.state === 'aside') {
        b.queue.shift();
        removeHold(memberId, bookId);
      }
      const dueDate = addDays(date, 21);
      m.loans.push({ bookId, dueDate, renewals: 0 });
      b.state = 'loan';
      b.holder = memberId;
      b.readyUntil = null;
      return { ok: true, dueDate };
    },

    returnBook(args) {
      const date = begin(args);
      if (date === null) return fail();
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail();
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail();
      if (b.state !== 'loan' || b.holder !== memberId) return fail();
      const idx = m.loans.findIndex(l => l.bookId === bookId);
      if (idx < 0) return fail();
      const loan = m.loans[idx];
      const daysLate = Math.max(0, parseDate(date) - parseDate(loan.dueDate));
      const fine = Math.min(500, 25 * Math.max(0, daysLate - 2));
      m.owed += fine;
      m.loans.splice(idx, 1);
      b.holder = null;
      if (b.queue.length === 0) {
        b.state = 'available';
        b.readyUntil = null;
      } else {
        b.state = 'aside';
        b.readyUntil = addDays(date, 7);
      }
      return { ok: true, fine };
    },

    renew(args) {
      const date = begin(args);
      if (date === null) return fail();
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail();
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail();
      if (b.state !== 'loan' || b.holder !== memberId) return fail();
      const loan = m.loans.find(l => l.bookId === bookId);
      if (!loan) return fail();
      if (loan.renewals >= 2) return fail();
      if (date > loan.dueDate) return fail();
      if (b.queue.length > 0) return fail();
      loan.dueDate = addDays(date, 21);
      loan.renewals++;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold(args) {
      const date = begin(args);
      if (date === null) return fail();
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail();
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail();
      if (b.state === 'available') return fail();
      if (b.state === 'loan' && b.holder === memberId) return fail();
      if (b.queue.includes(memberId)) return fail();
      if (m.holds.length >= 5) return fail();
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      const date = begin(args);
      if (date === null) return fail();
      const { memberId, amount } = args;
      if (!validId(memberId)) return fail();
      const m = members.get(memberId);
      if (!m) return fail();
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail();
      if (amount > m.owed) return fail();
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const date = begin(args);
      if (date === null) return fail();
      const { memberId } = args;
      if (!validId(memberId)) return fail();
      const m = members.get(memberId);
      if (!m) return fail();
      return {
        ok: true,
        loans: m.loans.map(l => ({ bookId: l.bookId, dueDate: l.dueDate })),
        owed: m.owed,
        holds: m.holds.map(bookId => {
          const b = books.get(bookId);
          const i = b.queue.indexOf(memberId);
          return {
            bookId,
            position: i + 1,
            readyUntil: b.state === 'aside' && i === 0 ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
