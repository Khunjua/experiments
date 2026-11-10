const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function isObj(v) {
  return typeof v === 'object' && v !== null;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

// Returns the day number (days since 1970-01-01, UTC) or null if invalid.
function toDayNum(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / MS_PER_DAY);
}

function fromDayNum(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dropItem(arr, v) {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
}

export function createLibrary() {
  // bookId -> { id, loan: { memberId, dueDate, renewals } | null, queue: [memberId], readyUntil: string | null }
  const books = new Map();
  // memberId -> { id, owed, loans: [bookId] (borrow order), holds: [bookId] (placement order) }
  const members = new Map();
  // current date as day number, or null when unset
  let current = null;

  function expire(n) {
    for (const book of books.values()) {
      while (
        book.loan === null &&
        book.queue.length > 0 &&
        toDayNum(book.readyUntil) < n
      ) {
        const gone = book.queue.shift();
        const member = members.get(gone);
        if (member) dropItem(member.holds, book.id);
        if (book.queue.length > 0) {
          book.readyUntil = fromDayNum(toDayNum(book.readyUntil) + 1 + PICKUP_DAYS);
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Applies the clock rule and hold expiry. Returns day number, or null if the date is earlier than current.
  function advance(date) {
    const n = toDayNum(date);
    if (n === null) return null;
    if (current !== null && n < current) return null;
    current = n;
    expire(n);
    return n;
  }

  function addBook(args) {
    if (!isObj(args) || !isId(args.bookId)) return { ok: false };
    if (books.has(args.bookId)) return { ok: false };
    books.set(args.bookId, {
      id: args.bookId,
      loan: null,
      queue: [],
      readyUntil: null,
    });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args) || !isId(args.memberId)) return { ok: false };
    if (members.has(args.memberId)) return { ok: false };
    members.set(args.memberId, {
      id: args.memberId,
      owed: 0,
      loans: [],
      holds: [],
    });
    return { ok: true };
  }

  function borrow(args) {
    if (
      !isObj(args) ||
      !isId(args.memberId) ||
      !isId(args.bookId) ||
      toDayNum(args.date) === null
    ) {
      return { ok: false };
    }
    const n = advance(args.date);
    if (n === null) return { ok: false };

    const { memberId, bookId } = args;
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (book.loan !== null) return { ok: false };
    if (book.queue.length > 0 && book.queue[0] !== memberId) return { ok: false };
    if (member.loans.length >= MAX_LOANS) return { ok: false };
    for (const b of member.loans) {
      const loan = books.get(b).loan;
      if (toDayNum(loan.dueDate) < n) return { ok: false };
    }
    if (member.owed >= BLOCK_OWED) return { ok: false };

    const dueDate = fromDayNum(n + LOAN_DAYS);
    book.loan = { memberId, dueDate, renewals: 0 };
    member.loans.push(bookId);

    if (book.queue.length > 0 && book.queue[0] === memberId) {
      book.queue.shift();
      dropItem(member.holds, bookId);
      book.readyUntil = null;
    }
    return { ok: true, dueDate };
  }

  function returnBook(args) {
    if (
      !isObj(args) ||
      !isId(args.memberId) ||
      !isId(args.bookId) ||
      toDayNum(args.date) === null
    ) {
      return { ok: false };
    }
    const n = advance(args.date);
    if (n === null) return { ok: false };

    const { memberId, bookId } = args;
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (!book.loan || book.loan.memberId !== memberId) return { ok: false };

    const daysLate = Math.max(0, n - toDayNum(book.loan.dueDate));
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));

    member.owed += fine;
    dropItem(member.loans, bookId);
    book.loan = null;

    if (book.queue.length > 0) {
      book.readyUntil = fromDayNum(n + PICKUP_DAYS);
    } else {
      book.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    if (
      !isObj(args) ||
      !isId(args.memberId) ||
      !isId(args.bookId) ||
      toDayNum(args.date) === null
    ) {
      return { ok: false };
    }
    const n = advance(args.date);
    if (n === null) return { ok: false };

    const { memberId, bookId } = args;
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (!book.loan || book.loan.memberId !== memberId) return { ok: false };
    if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (n > toDayNum(book.loan.dueDate)) return { ok: false };
    if (book.queue.length > 0) return { ok: false };

    const dueDate = fromDayNum(n + RENEWAL_DAYS);
    book.loan.dueDate = dueDate;
    book.loan.renewals += 1;
    return { ok: true, dueDate };
  }

  function placeHold(args) {
    if (
      !isObj(args) ||
      !isId(args.memberId) ||
      !isId(args.bookId) ||
      toDayNum(args.date) === null
    ) {
      return { ok: false };
    }
    const n = advance(args.date);
    if (n === null) return { ok: false };

    const { memberId, bookId } = args;
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (book.loan === null && book.queue.length === 0) return { ok: false };
    if (book.loan !== null && book.loan.memberId === memberId) return { ok: false };
    if (book.queue.includes(memberId)) return { ok: false };
    if (member.holds.length >= MAX_HOLDS) return { ok: false };

    book.queue.push(memberId);
    member.holds.push(bookId);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    if (
      !isObj(args) ||
      !isId(args.memberId) ||
      !Number.isSafeInteger(args.amount) ||
      args.amount <= 0 ||
      toDayNum(args.date) === null
    ) {
      return { ok: false };
    }
    const n = advance(args.date);
    if (n === null) return { ok: false };

    const member = members.get(args.memberId);
    if (!member) return { ok: false };
    if (args.amount > member.owed) return { ok: false };

    member.owed -= args.amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    if (
      !isObj(args) ||
      !isId(args.memberId) ||
      toDayNum(args.date) === null
    ) {
      return { ok: false };
    }
    const n = advance(args.date);
    if (n === null) return { ok: false };

    const { memberId } = args;
    const member = members.get(memberId);
    if (!member) return { ok: false };

    const loans = member.loans.map((bid) => ({
      bookId: bid,
      dueDate: books.get(bid).loan.dueDate,
    }));

    const holds = member.holds.map((bid) => {
      const book = books.get(bid);
      const position = book.queue.indexOf(memberId) + 1;
      const readyHere = book.loan === null && book.queue[0] === memberId;
      return {
        bookId: bid,
        position,
        readyUntil: readyHere ? book.readyUntil : null,
      };
    });

    return {
      ok: true,
      loans,
      owed: member.owed,
      holds,
    };
  }

  return {
    addBook,
    addMember,
    borrow,
    returnBook,
    renew,
    placeHold,
    payFine,
    getMember,
  };
}
