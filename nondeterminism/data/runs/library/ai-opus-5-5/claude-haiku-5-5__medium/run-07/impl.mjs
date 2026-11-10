const MS_PER_DAY = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function parseDay(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (y < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo || t.getUTCDate() !== d) return null;
  return t.getTime() / MS_PER_DAY;
}

function formatDay(n) {
  const t = new Date(n * MS_PER_DAY);
  return String(t.getUTCFullYear()).padStart(4, '0') + '-' +
    String(t.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(t.getUTCDate()).padStart(2, '0');
}

function removeFirst(arr, value) {
  const idx = arr.indexOf(value);
  if (idx >= 0) arr.splice(idx, 1);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, queue: [{ memberId }], readyUntil: day | null }
  const books = new Map();
  // memberId -> { loans: [bookId] (borrow order), holds: [bookId] (placement order), owed: cents }
  const members = new Map();
  let now = null;

  function expire(asOf) {
    for (const [bookId, book] of books) {
      while (book.loan === null && book.queue.length > 0 && asOf > book.readyUntil) {
        const gone = book.queue.shift();
        removeFirst(members.get(gone.memberId).holds, bookId);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Advances the clock. Returns false (no effect) if the date is earlier than the current date.
  function advance(day) {
    if (now !== null && day < now) return false;
    now = day;
    expire(day);
    return true;
  }

  return {
    addBook(args) {
      if (!isObj(args) || !isId(args.bookId) || books.has(args.bookId)) return { ok: false };
      books.set(args.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args) || !isId(args.memberId) || members.has(args.memberId)) return { ok: false };
      members.set(args.memberId, { loans: [], holds: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return { ok: false };
      const day = parseDay(args.date);
      if (day === null || !advance(day)) return { ok: false };
      const member = members.get(args.memberId);
      const book = books.get(args.bookId);
      if (!member || !book) return { ok: false };
      if (book.loan !== null) return { ok: false };
      if (book.queue.length > 0 && book.queue[0].memberId !== args.memberId) return { ok: false };
      if (member.loans.length >= MAX_LOANS) return { ok: false };
      if (member.loans.some((id) => books.get(id).loan.due < day)) return { ok: false };
      if (member.owed >= BLOCK_OWED) return { ok: false };

      book.loan = { memberId: args.memberId, due: day + LOAN_DAYS, renewals: 0 };
      member.loans.push(args.bookId);
      if (book.queue.length > 0) {
        book.queue.shift();
        removeFirst(member.holds, args.bookId);
        book.readyUntil = null;
      }
      return { ok: true, dueDate: formatDay(day + LOAN_DAYS) };
    },

    returnBook(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return { ok: false };
      const day = parseDay(args.date);
      if (day === null || !advance(day)) return { ok: false };
      const member = members.get(args.memberId);
      const book = books.get(args.bookId);
      if (!member || !book) return { ok: false };
      if (book.loan === null || book.loan.memberId !== args.memberId) return { ok: false };

      const late = Math.max(0, day - book.loan.due);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
      member.owed += fine;
      book.loan = null;
      removeFirst(member.loans, args.bookId);
      if (book.queue.length > 0) {
        book.readyUntil = day + PICKUP_DAYS;
      }
      return { ok: true, fine };
    },

    renew(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return { ok: false };
      const day = parseDay(args.date);
      if (day === null || !advance(day)) return { ok: false };
      const member = members.get(args.memberId);
      const book = books.get(args.bookId);
      if (!member || !book) return { ok: false };
      if (book.loan === null || book.loan.memberId !== args.memberId) return { ok: false };
      if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (day > book.loan.due) return { ok: false };
      if (book.queue.length > 0) return { ok: false };

      book.loan.due = day + RENEW_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: formatDay(book.loan.due) };
    },

    placeHold(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return { ok: false };
      const day = parseDay(args.date);
      if (day === null || !advance(day)) return { ok: false };
      const member = members.get(args.memberId);
      const book = books.get(args.bookId);
      if (!member || !book) return { ok: false };
      if (book.loan === null && book.queue.length === 0) return { ok: false };
      if (book.loan !== null && book.loan.memberId === args.memberId) return { ok: false };
      if (book.queue.some((h) => h.memberId === args.memberId)) return { ok: false };
      if (member.holds.length >= MAX_HOLDS) return { ok: false };

      book.queue.push({ memberId: args.memberId });
      member.holds.push(args.bookId);
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      if (!isObj(args) || !isId(args.memberId)) return { ok: false };
      const amount = args.amount;
      if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false };
      const day = parseDay(args.date);
      if (day === null || !advance(day)) return { ok: false };
      const member = members.get(args.memberId);
      if (!member) return { ok: false };
      if (amount > member.owed) return { ok: false };

      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember(args) {
      if (!isObj(args) || !isId(args.memberId)) return { ok: false };
      const day = parseDay(args.date);
      if (day === null || !advance(day)) return { ok: false };
      const member = members.get(args.memberId);
      if (!member) return { ok: false };

      const loans = member.loans.map((bookId) => ({
        bookId,
        dueDate: formatDay(books.get(bookId).loan.due),
      }));

      const holds = member.holds.map((bookId) => {
        const book = books.get(bookId);
        const position = book.queue.findIndex((h) => h.memberId === args.memberId) + 1;
        const ready = book.loan === null && position === 1;
        return {
          bookId,
          position,
          readyUntil: ready ? formatDay(book.readyUntil) : null,
        };
      });

      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
