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
const MS_PER_DAY = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.getTime() / MS_PER_DAY;
}

function formatDay(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const MAX_DAY = parseDate('9999-12-31');

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function validArgs(a) {
  return a !== null && typeof a === 'object';
}

export function createLibrary() {
  // bookId -> { state: 'available' | 'onLoan' | 'setAside', borrower, queue: [{ memberId, seq }], readyDay }
  const books = new Map();
  // memberId -> { loans: [{ bookId, dueDay, renewals }], owed }
  const members = new Map();
  let current = null;
  let seqCounter = 0;

  const fail = () => ({ ok: false });

  function clockOk(day) {
    return day !== null && (current === null || day >= current);
  }

  function advance(day) {
    current = day;
    expire(day);
  }

  function expire(day) {
    for (const book of books.values()) {
      while (book.state === 'setAside' && day > book.readyDay) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyDay = Math.min(book.readyDay + 1 + PICKUP_DAYS, MAX_DAY);
        } else {
          book.state = 'available';
          book.borrower = null;
          book.readyDay = null;
        }
      }
    }
  }

  return {
    addBook(args) {
      if (!validArgs(args) || !validId(args.bookId)) return fail();
      if (books.has(args.bookId)) return fail();
      books.set(args.bookId, { state: 'available', borrower: null, queue: [], readyDay: null });
      return { ok: true };
    },

    addMember(args) {
      if (!validArgs(args) || !validId(args.memberId)) return fail();
      if (members.has(args.memberId)) return fail();
      members.set(args.memberId, { loans: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      if (!validArgs(args) || !validId(args.memberId) || !validId(args.bookId)) return fail();
      const day = parseDate(args.date);
      if (!clockOk(day)) return fail();
      advance(day);

      const member = members.get(args.memberId);
      const book = books.get(args.bookId);
      if (!member || !book) return fail();
      if (book.state === 'onLoan') return fail();

      const isHeld = book.state === 'setAside' && book.queue[0].memberId === args.memberId;
      if (book.state === 'setAside' && !isHeld) return fail();
      if (member.loans.length >= MAX_LOANS) return fail();
      if (member.loans.some((l) => l.dueDay < day)) return fail();
      if (member.owed >= BLOCK_OWED) return fail();
      const dueDay = day + LOAN_DAYS;
      if (dueDay > MAX_DAY) return fail();

      member.loans.push({ bookId: args.bookId, dueDay, renewals: 0 });
      if (isHeld) book.queue.shift();
      book.state = 'onLoan';
      book.borrower = args.memberId;
      book.readyDay = null;
      return { ok: true, dueDate: formatDay(dueDay) };
    },

    returnBook(args) {
      if (!validArgs(args) || !validId(args.memberId) || !validId(args.bookId)) return fail();
      const day = parseDate(args.date);
      if (!clockOk(day)) return fail();
      advance(day);

      const member = members.get(args.memberId);
      const book = books.get(args.bookId);
      if (!member || !book) return fail();
      if (book.state !== 'onLoan' || book.borrower !== args.memberId) return fail();
      const idx = member.loans.findIndex((l) => l.bookId === args.bookId);
      if (idx < 0) return fail();

      const loan = member.loans[idx];
      const late = Math.max(0, day - loan.dueDay);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
      member.owed += fine;
      member.loans.splice(idx, 1);

      book.borrower = null;
      if (book.queue.length === 0) {
        book.state = 'available';
        book.readyDay = null;
      } else {
        book.state = 'setAside';
        book.readyDay = Math.min(day + PICKUP_DAYS, MAX_DAY);
      }
      return { ok: true, fine };
    },

    renew(args) {
      if (!validArgs(args) || !validId(args.memberId) || !validId(args.bookId)) return fail();
      const day = parseDate(args.date);
      if (!clockOk(day)) return fail();
      advance(day);

      const member = members.get(args.memberId);
      const book = books.get(args.bookId);
      if (!member || !book) return fail();
      if (book.state !== 'onLoan' || book.borrower !== args.memberId) return fail();
      const loan = member.loans.find((l) => l.bookId === args.bookId);
      if (!loan) return fail();
      if (loan.renewals >= MAX_RENEWALS) return fail();
      if (day > loan.dueDay) return fail();
      if (book.queue.length > 0) return fail();
      const newDue = day + RENEW_DAYS;
      if (newDue > MAX_DAY) return fail();

      loan.dueDay = newDue;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(newDue) };
    },

    placeHold(args) {
      if (!validArgs(args) || !validId(args.memberId) || !validId(args.bookId)) return fail();
      const day = parseDate(args.date);
      if (!clockOk(day)) return fail();
      advance(day);

      const member = members.get(args.memberId);
      const book = books.get(args.bookId);
      if (!member || !book) return fail();
      if (book.state === 'available') return fail();
      if (member.loans.some((l) => l.bookId === args.bookId)) return fail();
      if (book.queue.some((h) => h.memberId === args.memberId)) return fail();

      let active = 0;
      for (const b of books.values()) {
        if (b.queue.some((h) => h.memberId === args.memberId)) active += 1;
      }
      if (active >= MAX_HOLDS) return fail();

      book.queue.push({ memberId: args.memberId, seq: seqCounter++ });
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      if (!validArgs(args) || !validId(args.memberId)) return fail();
      const amount = args.amount;
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail();
      const day = parseDate(args.date);
      if (!clockOk(day)) return fail();
      advance(day);

      const member = members.get(args.memberId);
      if (!member) return fail();
      if (amount > member.owed) return fail();

      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember(args) {
      if (!validArgs(args) || !validId(args.memberId)) return fail();
      const day = parseDate(args.date);
      if (!clockOk(day)) return fail();
      advance(day);

      const member = members.get(args.memberId);
      if (!member) return fail();

      const loans = member.loans.map((l) => ({
        bookId: l.bookId,
        dueDate: formatDay(l.dueDay),
      }));

      const entries = [];
      for (const [bookId, book] of books) {
        const idx = book.queue.findIndex((h) => h.memberId === args.memberId);
        if (idx < 0) continue;
        const ready = idx === 0 && book.state === 'setAside';
        entries.push({
          seq: book.queue[idx].seq,
          hold: {
            bookId,
            position: idx + 1,
            readyUntil: ready ? formatDay(book.readyDay) : null,
          },
        });
      }
      entries.sort((a, b) => a.seq - b.seq);
      const holds = entries.map((e) => e.hold);

      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
