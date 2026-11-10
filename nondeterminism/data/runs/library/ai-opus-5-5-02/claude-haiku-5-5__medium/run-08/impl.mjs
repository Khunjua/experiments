const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const GRACE_DAYS = 0;
const BORROW_BLOCK_OWED = 1000;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;

function fail() {
  return { ok: false };
}

function isObj(x) {
  return typeof x === 'object' && x !== null;
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

// Returns the whole-day number since 1970-01-01 (UTC), or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return Math.round(dt.getTime() / DAY_MS);
}

function formatDate(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

export function createLibrary() {
  // book: { id, state: 'shelf' | 'loan' | 'aside', holder, readyDay, queue: [memberId] }
  // member: { id, owed, loans: Map<bookId, {bookId, dueDay, renewals, seq}>, holds: [{bookId}] }
  const books = new Map();
  const members = new Map();
  let latest = null;
  let seq = 0;

  function removeHold(member, bookId) {
    member.holds = member.holds.filter((h) => h.bookId !== bookId);
  }

  // Expiry processing up to day `today`.
  function expire(today) {
    for (const book of books.values()) {
      while (book.state === 'aside' && book.readyDay < today) {
        const expiredMember = members.get(book.holder);
        if (expiredMember) removeHold(expiredMember, book.id);
        const start = book.readyDay + 1;
        if (book.queue.length > 0) {
          book.holder = book.queue.shift();
          book.readyDay = start + PICKUP_DAYS;
        } else {
          book.state = 'shelf';
          book.holder = null;
          book.readyDay = null;
        }
      }
    }
  }

  // Handles the time rules for a dated call. Returns the day number, or null
  // if the call must be rejected.
  function admit(args) {
    if (!isObj(args)) return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (latest !== null && day < latest) return null;
    latest = day;
    expire(day);
    return day;
  }

  function findMember(args) {
    return validId(args.memberId) ? members.get(args.memberId) : undefined;
  }

  function findBook(args) {
    return validId(args.bookId) ? books.get(args.bookId) : undefined;
  }

  function holdView(member, hold) {
    const book = books.get(hold.bookId);
    if (book.state === 'aside' && book.holder === member.id) {
      return {
        bookId: book.id,
        position: 1,
        readyUntil: formatDate(book.readyDay),
      };
    }
    const index = book.queue.indexOf(member.id);
    const position = index + 1 + (book.state === 'aside' ? 1 : 0);
    return { bookId: book.id, position, readyUntil: null };
  }

  return {
    addBook(args) {
      if (!isObj(args) || !validId(args.bookId) || books.has(args.bookId)) {
        return fail();
      }
      books.set(args.bookId, {
        id: args.bookId,
        state: 'shelf',
        holder: null,
        readyDay: null,
        queue: [],
      });
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args) || !validId(args.memberId) || members.has(args.memberId)) {
        return fail();
      }
      members.set(args.memberId, {
        id: args.memberId,
        owed: 0,
        loans: new Map(),
        holds: [],
      });
      return { ok: true };
    },

    borrow(args) {
      const day = admit(args);
      if (day === null) return fail();
      const m = findMember(args);
      const b = findBook(args);
      if (!m || !b) return fail();
      if (b.state === 'loan') return fail();
      if (b.state === 'aside' && b.holder !== m.id) return fail();
      if (b.state === 'shelf' && b.queue.length > 0) return fail();
      if (m.loans.size >= MAX_LOANS) return fail();
      if (m.owed >= BORROW_BLOCK_OWED) return fail();

      if (b.state === 'aside') {
        removeHold(m, b.id);
        b.readyDay = null;
      }
      const dueDay = day + LOAN_DAYS;
      m.loans.set(b.id, { bookId: b.id, dueDay, renewals: 0, seq: ++seq });
      b.state = 'loan';
      b.holder = m.id;
      return { ok: true, dueDate: formatDate(dueDay) };
    },

    returnBook(args) {
      const day = admit(args);
      if (day === null) return fail();
      const m = findMember(args);
      const b = findBook(args);
      if (!m || !b) return fail();
      const loan = m.loans.get(b.id);
      if (!loan || b.state !== 'loan' || b.holder !== m.id) return fail();

      const daysLate = Math.max(0, day - loan.dueDay - GRACE_DAYS);
      const fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      m.owed += fine;
      m.loans.delete(b.id);

      if (b.queue.length > 0) {
        b.holder = b.queue.shift();
        b.state = 'aside';
        b.readyDay = day + PICKUP_DAYS;
      } else {
        b.state = 'shelf';
        b.holder = null;
        b.readyDay = null;
      }
      return { ok: true, fine };
    },

    renew(args) {
      const day = admit(args);
      if (day === null) return fail();
      const m = findMember(args);
      const b = findBook(args);
      if (!m || !b) return fail();
      const loan = m.loans.get(b.id);
      if (!loan || b.state !== 'loan' || b.holder !== m.id) return fail();
      if (loan.renewals >= MAX_RENEWALS) return fail();
      if (day > loan.dueDay) return fail();
      if (b.queue.length > 0) return fail();

      loan.dueDay = day + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(loan.dueDay) };
    },

    placeHold(args) {
      const day = admit(args);
      if (day === null) return fail();
      const m = findMember(args);
      const b = findBook(args);
      if (!m || !b) return fail();
      if (b.state === 'shelf') return fail();
      if (b.state === 'loan' && b.holder === m.id) return fail();
      if (b.queue.includes(m.id)) return fail();
      if (b.state === 'aside' && b.holder === m.id) return fail();
      if (m.holds.length >= MAX_HOLDS) return fail();

      b.queue.push(m.id);
      m.holds.push({ bookId: b.id });
      const position = b.queue.length + (b.state === 'aside' ? 1 : 0);
      return { ok: true, position };
    },

    payFine(args) {
      const day = admit(args);
      if (day === null) return fail();
      const m = findMember(args);
      if (!m) return fail();
      const amount = args.amount;
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return fail();
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const day = admit(args);
      if (day === null) return fail();
      const m = findMember(args);
      if (!m) return fail();

      const loans = [...m.loans.values()]
        .sort((x, y) => x.seq - y.seq)
        .map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.dueDay) }));
      const holds = m.holds.map((h) => holdView(m, h));
      return { loans, owed: m.owed, holds };
    },
  };
}
