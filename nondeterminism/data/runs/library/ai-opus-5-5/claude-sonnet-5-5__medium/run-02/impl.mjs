const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime();
}

const DAY = 86400000;

function fmt(ms) {
  const dt = new Date(ms);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return fmt(parseDate(s) + n * DAY);
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

const FAIL = () => ({ ok: false });

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  function removeMemberHold(memberId, bookId) {
    const m = members.get(memberId);
    if (!m) return;
    const i = m.holds.indexOf(bookId);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function expire(date) {
    for (const [bookId, b] of books) {
      while (b.state === 'aside' && date > b.readyUntil) {
        const gone = b.queue.shift();
        removeMemberHold(gone, bookId);
        if (b.queue.length > 0) {
          b.readyUntil = addDays(b.readyUntil, 8);
        } else {
          b.state = 'available';
          b.readyUntil = null;
        }
      }
    }
  }

  // Returns date string if call is acceptable, else null. Updates clock and expires.
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const t = parseDate(args.date);
    if (t === null) return null;
    if (current !== null && args.date < current) return null;
    current = args.date;
    expire(args.date);
    return args.date;
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return FAIL();
      const { bookId } = args;
      if (!validId(bookId) || books.has(bookId)) return FAIL();
      books.set(bookId, { state: 'available', queue: [], readyUntil: null, loanMember: null });
      return { ok: true };
    },

    addMember(args) {
      if (args === null || typeof args !== 'object') return FAIL();
      const { memberId } = args;
      if (!validId(memberId) || members.has(memberId)) return FAIL();
      members.set(memberId, { owed: 0, loans: [], holds: [] });
      return { ok: true };
    },

    borrow(args) {
      const date = begin(args);
      if (date === null) return FAIL();
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return FAIL();
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return FAIL();
      if (b.state === 'loan') return FAIL();
      if (b.state === 'aside' && b.queue[0] !== memberId) return FAIL();
      if (m.loans.length >= 5) return FAIL();
      if (m.loans.some((l) => l.dueDate < date)) return FAIL();
      if (m.owed >= 1000) return FAIL();
      if (b.state === 'aside') {
        b.queue.shift();
        removeMemberHold(memberId, bookId);
        b.readyUntil = null;
      }
      b.state = 'loan';
      b.loanMember = memberId;
      const dueDate = addDays(date, 21);
      m.loans.push({ bookId, dueDate, renewals: 0 });
      return { ok: true, dueDate };
    },

    returnBook(args) {
      const date = begin(args);
      if (date === null) return FAIL();
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return FAIL();
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return FAIL();
      if (b.state !== 'loan' || b.loanMember !== memberId) return FAIL();
      const idx = m.loans.findIndex((l) => l.bookId === bookId);
      if (idx < 0) return FAIL();
      const loan = m.loans[idx];
      const daysLate = Math.max(0, Math.round((parseDate(date) - parseDate(loan.dueDate)) / DAY));
      const fine = Math.min(500, 25 * Math.max(0, daysLate - 2));
      m.owed += fine;
      m.loans.splice(idx, 1);
      b.loanMember = null;
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
      if (date === null) return FAIL();
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return FAIL();
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return FAIL();
      if (b.state !== 'loan' || b.loanMember !== memberId) return FAIL();
      const loan = m.loans.find((l) => l.bookId === bookId);
      if (!loan) return FAIL();
      if (loan.renewals >= 2) return FAIL();
      if (date > loan.dueDate) return FAIL();
      if (b.queue.length > 0) return FAIL();
      loan.renewals += 1;
      loan.dueDate = addDays(date, 21);
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold(args) {
      const date = begin(args);
      if (date === null) return FAIL();
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return FAIL();
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return FAIL();
      if (b.state === 'available') return FAIL();
      if (b.state === 'loan' && b.loanMember === memberId) return FAIL();
      if (b.queue.includes(memberId)) return FAIL();
      if (m.holds.length >= 5) return FAIL();
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      const date = begin(args);
      if (date === null) return FAIL();
      const { memberId, amount } = args;
      if (!validId(memberId)) return FAIL();
      if (!Number.isSafeInteger(amount) || amount <= 0) return FAIL();
      const m = members.get(memberId);
      if (!m) return FAIL();
      if (amount > m.owed) return FAIL();
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const date = begin(args);
      if (date === null) return FAIL();
      const { memberId } = args;
      if (!validId(memberId)) return FAIL();
      const m = members.get(memberId);
      if (!m) return FAIL();
      return {
        ok: true,
        loans: m.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate })),
        owed: m.owed,
        holds: m.holds.map((bookId) => {
          const b = books.get(bookId);
          return {
            bookId,
            position: b.queue.indexOf(memberId) + 1,
            readyUntil: b.state === 'aside' && b.queue[0] === memberId ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
