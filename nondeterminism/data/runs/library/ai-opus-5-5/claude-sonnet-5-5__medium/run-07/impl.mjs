const DAY = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime() / DAY;
}

function formatDate(n) {
  const dt = new Date(n * DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return formatDate(parseDate(s) + n);
}

const validId = (x) => typeof x === 'string' && x.length > 0;
const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  // Validates the date, advances the clock, runs expiry. Returns date string or null.
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const date = args.date;
    if (parseDate(date) === null) return null;
    if (current !== null && date < current) return null;
    current = date;
    expire(date);
    return date;
  }

  function expire(date) {
    for (const b of books.values()) {
      while (b.state === 'aside' && date > b.readyUntil) {
        const gone = b.queue.shift();
        const gm = members.get(gone);
        if (gm) {
          const i = gm.holds.indexOf(b.id);
          if (i >= 0) gm.holds.splice(i, 1);
        }
        if (b.queue.length > 0) {
          b.readyUntil = addDays(b.readyUntil, 8);
        } else {
          b.state = 'available';
          b.readyUntil = null;
        }
      }
    }
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return FAIL('invalid');
      const { bookId } = args;
      if (!validId(bookId) || books.has(bookId)) return FAIL('invalid');
      books.set(bookId, {
        id: bookId, state: 'available', loanMember: null, dueDate: null,
        renewals: 0, queue: [], readyUntil: null,
      });
      return { ok: true };
    },

    addMember(args) {
      if (args === null || typeof args !== 'object') return FAIL('invalid');
      const { memberId } = args;
      if (!validId(memberId) || members.has(memberId)) return FAIL('invalid');
      members.set(memberId, { id: memberId, owed: 0, loans: [], holds: [] });
      return { ok: true };
    },

    borrow(args) {
      const date = begin(args);
      if (date === null) return FAIL('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.state === 'loan') return FAIL('on loan');
      if (b.state === 'aside' && b.queue[0] !== memberId) return FAIL('set aside');
      if (m.loans.length >= 5) return FAIL('limit');
      for (const id of m.loans) {
        if (books.get(id).dueDate < date) return FAIL('overdue');
      }
      if (m.owed >= 1000) return FAIL('owed');
      if (b.state === 'aside') {
        b.queue.shift();
        const i = m.holds.indexOf(bookId);
        if (i >= 0) m.holds.splice(i, 1);
        b.readyUntil = null;
      }
      b.state = 'loan';
      b.loanMember = memberId;
      b.dueDate = addDays(date, 21);
      b.renewals = 0;
      m.loans.push(bookId);
      return { ok: true, dueDate: b.dueDate };
    },

    returnBook(args) {
      const date = begin(args);
      if (date === null) return FAIL('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.state !== 'loan' || b.loanMember !== memberId) return FAIL('not on loan');
      const daysLate = Math.max(0, parseDate(date) - parseDate(b.dueDate));
      const fine = Math.min(500, 25 * Math.max(0, daysLate - 2));
      m.owed += fine;
      const i = m.loans.indexOf(bookId);
      if (i >= 0) m.loans.splice(i, 1);
      b.loanMember = null;
      b.dueDate = null;
      b.renewals = 0;
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
      if (date === null) return FAIL('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.state !== 'loan' || b.loanMember !== memberId) return FAIL('not on loan');
      if (b.renewals >= 2) return FAIL('max renewals');
      if (date > b.dueDate) return FAIL('overdue');
      if (b.queue.length > 0) return FAIL('holds');
      b.dueDate = addDays(date, 21);
      b.renewals += 1;
      return { ok: true, dueDate: b.dueDate };
    },

    placeHold(args) {
      const date = begin(args);
      if (date === null) return FAIL('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.state === 'available') return FAIL('available');
      if (b.state === 'loan' && b.loanMember === memberId) return FAIL('own loan');
      if (b.queue.includes(memberId)) return FAIL('duplicate');
      if (m.holds.length >= 5) return FAIL('limit');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      const date = begin(args);
      if (date === null) return FAIL('date');
      const { memberId, amount } = args;
      if (!validId(memberId)) return FAIL('invalid');
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return FAIL('amount');
      const m = members.get(memberId);
      if (!m) return FAIL('unknown');
      if (amount > m.owed) return FAIL('overpay');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const date = begin(args);
      if (date === null) return FAIL('date');
      const { memberId } = args;
      if (!validId(memberId)) return FAIL('invalid');
      const m = members.get(memberId);
      if (!m) return FAIL('unknown');
      return {
        ok: true,
        loans: m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).dueDate })),
        owed: m.owed,
        holds: m.holds.map((id) => {
          const b = books.get(id);
          const pos = b.queue.indexOf(memberId) + 1;
          return {
            bookId: id,
            position: pos,
            readyUntil: b.state === 'aside' && pos === 1 ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
