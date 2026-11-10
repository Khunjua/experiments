const DAY = 86400000;
const RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  if (typeof s !== 'string' || !RE.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
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

const validId = (x) => typeof x === 'string' && x.length > 0;
const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  function expire(day) {
    for (const [id, b] of books) {
      if (b.state !== 'aside') continue;
      while (b.state === 'aside' && b.readyUntil < day) {
        const h = b.queue.shift();
        const m = members.get(h);
        const i = m.holds.indexOf(id);
        if (i >= 0) m.holds.splice(i, 1);
        if (b.queue.length) b.readyUntil = b.readyUntil + 8;
        else { b.state = 'available'; b.readyUntil = null; }
      }
    }
  }

  // returns day number or null on failure; sets clock and expires
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    expire(day);
    return day;
  }

  return {
    addBook(args) {
      if (!args || typeof args !== 'object') return fail('args');
      const { bookId } = args;
      if (!validId(bookId) || books.has(bookId)) return fail('invalid');
      books.set(bookId, { state: 'available', borrower: null, due: 0, renewals: 0, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(args) {
      if (!args || typeof args !== 'object') return fail('args');
      const { memberId } = args;
      if (!validId(memberId) || members.has(memberId)) return fail('invalid');
      members.set(memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },
    borrow(args) {
      const day = begin(args);
      if (day === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.state === 'loan') return fail('on loan');
      if (b.state === 'aside' && b.queue[0] !== memberId) return fail('set aside');
      if (m.loans.length >= 5) return fail('limit');
      if (m.owed >= 1000) return fail('owed');
      for (const id of m.loans) if (books.get(id).due < day) return fail('overdue');
      if (b.state === 'aside') {
        b.queue.shift();
        const i = m.holds.indexOf(bookId);
        if (i >= 0) m.holds.splice(i, 1);
      }
      b.state = 'loan';
      b.borrower = memberId;
      b.due = day + 21;
      b.renewals = 0;
      b.readyUntil = null;
      m.loans.push(bookId);
      return { ok: true, dueDate: fmt(b.due) };
    },
    returnBook(args) {
      const day = begin(args);
      if (day === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.state !== 'loan' || b.borrower !== memberId) return fail('not borrowed');
      const late = Math.max(0, day - b.due);
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(bookId), 1);
      b.borrower = null;
      if (b.queue.length) { b.state = 'aside'; b.readyUntil = day + 7; }
      else { b.state = 'available'; b.readyUntil = null; }
      return { ok: true, fine };
    },
    renew(args) {
      const day = begin(args);
      if (day === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.state !== 'loan' || b.borrower !== memberId) return fail('not borrowed');
      if (b.renewals >= 2) return fail('max renewals');
      if (day > b.due) return fail('overdue');
      if (b.queue.length) return fail('holds');
      b.due = day + 21;
      b.renewals++;
      return { ok: true, dueDate: fmt(b.due) };
    },
    placeHold(args) {
      const day = begin(args);
      if (day === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.state === 'available') return fail('available');
      if (b.state === 'loan' && b.borrower === memberId) return fail('own loan');
      if (b.queue.includes(memberId)) return fail('duplicate');
      if (m.holds.length >= 5) return fail('limit');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(args) {
      const day = begin(args);
      if (day === null) return fail('date');
      const { memberId, amount } = args;
      if (!validId(memberId)) return fail('id');
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail('amount');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (amount > m.owed) return fail('overpay');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember(args) {
      const day = begin(args);
      if (day === null) return fail('date');
      const { memberId } = args;
      if (!validId(memberId)) return fail('id');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      return {
        ok: true,
        loans: m.loans.map((id) => ({ bookId: id, dueDate: fmt(books.get(id).due) })),
        owed: m.owed,
        holds: m.holds.map((id) => {
          const b = books.get(id);
          const pos = b.queue.indexOf(memberId) + 1;
          return {
            bookId: id,
            position: pos,
            readyUntil: b.state === 'aside' && pos === 1 ? fmt(b.readyUntil) : null,
          };
        }),
      };
    },
  };
}
