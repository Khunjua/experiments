const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const BLOCK_THRESHOLD = 500;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDate(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isAmount(x) {
  return Number.isInteger(x) && x > 0;
}

function obj(x) {
  return x !== null && typeof x === 'object' ? x : {};
}

function removeItem(arr, x) {
  const i = arr.indexOf(x);
  if (i >= 0) arr.splice(i, 1);
}

function fail() {
  return { ok: false };
}

function guard(fn) {
  try {
    return fn();
  } catch {
    return { ok: false };
  }
}

export function createLibrary() {
  // id -> { id, state: 'available'|'loan'|'aside', member, dueDate, renewals, line, readyUntil }
  const books = new Map();
  // id -> { owed, loans: [bookId], holds: [bookId] }
  const members = new Map();

  function expire(today) {
    for (const book of books.values()) {
      if (book.state !== 'aside') continue;
      while (book.state === 'aside' && today > book.readyUntil) {
        const gone = book.line.shift();
        const gm = members.get(gone);
        if (gm) removeItem(gm.holds, book.id);
        if (book.line.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.member = null;
          book.dueDate = null;
          book.renewals = 0;
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates the date and, if valid, runs expiry processing. Returns epoch day or null.
  function withDate(date) {
    const t = parseDate(date);
    if (t === null) return null;
    expire(t);
    return t;
  }

  return {
    addBook(arg) {
      return guard(() => {
        const a = obj(arg);
        const bookId = a.bookId;
        if (!isId(bookId)) return fail();
        if (books.has(bookId)) return fail();
        books.set(bookId, {
          id: bookId,
          state: 'available',
          member: null,
          dueDate: null,
          renewals: 0,
          line: [],
          readyUntil: null,
        });
        return { ok: true };
      });
    },

    addMember(arg) {
      return guard(() => {
        const a = obj(arg);
        const memberId = a.memberId;
        if (!isId(memberId)) return fail();
        if (members.has(memberId)) return fail();
        members.set(memberId, { owed: 0, loans: [], holds: [] });
        return { ok: true };
      });
    },

    borrow(arg) {
      return guard(() => {
        const a = obj(arg);
        const today = withDate(a.date);
        if (today === null) return fail();
        const mid = a.memberId;
        const bid = a.bookId;
        if (!isId(mid) || !isId(bid)) return fail();
        const m = members.get(mid);
        const b = books.get(bid);
        if (!m || !b) return fail();
        if (b.state === 'loan') return fail();
        if (b.state === 'aside' && b.line[0] !== mid) return fail();
        if (m.owed >= BLOCK_THRESHOLD) return fail();
        for (const lid of m.loans) {
          const lb = books.get(lid);
          if (lb && lb.dueDate < today) return fail();
        }
        if (b.state === 'aside') {
          b.line.shift();
          removeItem(m.holds, bid);
        }
        b.state = 'loan';
        b.member = mid;
        b.dueDate = today + LOAN_DAYS;
        b.renewals = 0;
        b.readyUntil = null;
        m.loans.push(bid);
        return { ok: true, dueDate: formatDate(b.dueDate) };
      });
    },

    returnBook(arg) {
      return guard(() => {
        const a = obj(arg);
        const today = withDate(a.date);
        if (today === null) return fail();
        const mid = a.memberId;
        const bid = a.bookId;
        if (!isId(mid) || !isId(bid)) return fail();
        const m = members.get(mid);
        const b = books.get(bid);
        if (!m || !b) return fail();
        if (b.state !== 'loan' || b.member !== mid) return fail();

        const late = today - b.dueDate;
        const chargeable = Math.max(0, late - GRACE_DAYS);
        const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);

        m.owed += fine;
        removeItem(m.loans, bid);
        b.member = null;
        b.dueDate = null;
        b.renewals = 0;

        if (b.line.length > 0) {
          b.state = 'aside';
          b.member = b.line[0];
          b.readyUntil = today + PICKUP_DAYS;
        } else {
          b.state = 'available';
          b.readyUntil = null;
        }
        return { ok: true, fine };
      });
    },

    renew(arg) {
      return guard(() => {
        const a = obj(arg);
        const today = withDate(a.date);
        if (today === null) return fail();
        const mid = a.memberId;
        const bid = a.bookId;
        if (!isId(mid) || !isId(bid)) return fail();
        const m = members.get(mid);
        const b = books.get(bid);
        if (!m || !b) return fail();
        if (b.state !== 'loan' || b.member !== mid) return fail();
        if (today > b.dueDate) return fail();
        if (b.renewals >= MAX_RENEWALS) return fail();
        if (b.line.length > 0) return fail();
        if (m.owed >= BLOCK_THRESHOLD) return fail();

        b.dueDate = today + LOAN_DAYS;
        b.renewals += 1;
        return { ok: true, dueDate: formatDate(b.dueDate) };
      });
    },

    placeHold(arg) {
      return guard(() => {
        const a = obj(arg);
        const today = withDate(a.date);
        if (today === null) return fail();
        const mid = a.memberId;
        const bid = a.bookId;
        if (!isId(mid) || !isId(bid)) return fail();
        const m = members.get(mid);
        const b = books.get(bid);
        if (!m || !b) return fail();
        if (b.state === 'available') return fail();
        if (b.state === 'loan' && b.member === mid) return fail();
        if (b.line.includes(mid)) return fail();

        b.line.push(mid);
        m.holds.push(bid);
        return { ok: true, position: b.line.length };
      });
    },

    payFine(arg) {
      return guard(() => {
        const a = obj(arg);
        const today = withDate(a.date);
        if (today === null) return fail();
        const mid = a.memberId;
        if (!isId(mid)) return fail();
        const m = members.get(mid);
        if (!m) return fail();
        const amount = a.amount;
        if (!isAmount(amount)) return fail();
        if (amount > m.owed) return fail();

        m.owed -= amount;
        return { ok: true, owed: m.owed };
      });
    },

    getMember(arg) {
      return guard(() => {
        const a = obj(arg);
        const today = withDate(a.date);
        if (today === null) return fail();
        const mid = a.memberId;
        if (!isId(mid)) return fail();
        const m = members.get(mid);
        if (!m) return fail();

        const loans = m.loans.map((bid) => {
          const b = books.get(bid);
          return { bookId: bid, dueDate: formatDate(b.dueDate) };
        });

        const holds = m.holds.map((bid) => {
          const b = books.get(bid);
          const position = b.line.indexOf(mid) + 1;
          const setAsideForMember = b.state === 'aside' && b.line[0] === mid;
          return {
            bookId: bid,
            position,
            readyUntil: setAsideForMember ? formatDate(b.readyUntil) : null,
          };
        });

        return { loans, owed: m.owed, holds };
      });
    },
  };
}
