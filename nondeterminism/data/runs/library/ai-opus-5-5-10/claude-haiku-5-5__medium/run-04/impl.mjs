const MS_PER_DAY = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE = 1000;
const DEBT_LIMIT = 1000;
const PICKUP_DAYS = 7;

function isObject(v) {
  return v !== null && typeof v === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

// Returns the day number (days since 1970-01-01, UTC arithmetic) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > daysInMonth(y, mo)) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDate(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  // bookId -> { loanedTo: memberId|null, readyUntil: dayNum|null, queue: [{ memberId, seq }] }
  const books = new Map();
  // memberId -> { owed: cents, loans: [{ bookId, dueDay, renewals }] }  (loans in creation order)
  const members = new Map();
  let lastDay = null;
  let nextSeq = 0;

  const fail = (reason) => ({ ok: false, reason });

  // §4 expiry processing, run for every book.
  function expire(day) {
    for (const book of books.values()) {
      while (book.loanedTo === null && book.readyUntil !== null && day > book.readyUntil) {
        book.queue.shift();
        const s = book.readyUntil + 1;
        if (book.queue.length > 0) {
          book.readyUntil = s + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // §3.5 clock. Returns the accepted day number, or null if the date is
  // invalid or earlier than lastDay. Runs time processing when accepted.
  function admit(date) {
    const day = parseDate(date);
    if (day === null) return null;
    if (lastDay !== null && day < lastDay) return null;
    lastDay = day;
    expire(day);
    return day;
  }

  function addBook(args) {
    if (!isObject(args) || !isId(args.bookId)) return fail('invalid arguments');
    if (books.has(args.bookId)) return fail('book exists');
    books.set(args.bookId, { loanedTo: null, readyUntil: null, queue: [] });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObject(args) || !isId(args.memberId)) return fail('invalid arguments');
    if (members.has(args.memberId)) return fail('member exists');
    members.set(args.memberId, { owed: 0, loans: [] });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObject(args) || !isId(args.memberId) || !isId(args.bookId)) return fail('invalid arguments');
    const day = admit(args.date);
    if (day === null) return fail('invalid or out-of-order date');
    const member = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!member || !book) return fail('not found');
    if (book.loanedTo !== null) return fail('on loan');
    if (book.readyUntil !== null) {
      if (book.queue[0].memberId !== args.memberId) return fail('set aside for another member');
    } else if (book.queue.length > 0) {
      return fail('waiting list not empty');
    }
    if (member.owed >= DEBT_LIMIT) return fail('debt limit');
    if (member.loans.some((l) => day > l.dueDay)) return fail('overdue loan');
    if (member.loans.length >= MAX_LOANS) return fail('loan limit');

    const dueDay = day + LOAN_DAYS;
    member.loans.push({ bookId: args.bookId, dueDay, renewals: 0 });
    book.loanedTo = args.memberId;
    if (book.readyUntil !== null) {
      // Set aside for this member: remove their hold; the rest move up.
      book.queue.shift();
      book.readyUntil = null;
    }
    return { ok: true, dueDate: formatDate(dueDay) };
  }

  function returnBook(args) {
    if (!isObject(args) || !isId(args.memberId) || !isId(args.bookId)) return fail('invalid arguments');
    const day = admit(args.date);
    if (day === null) return fail('invalid or out-of-order date');
    const member = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!member || !book) return fail('not found');
    const idx = member.loans.findIndex((l) => l.bookId === args.bookId);
    if (idx < 0 || book.loanedTo !== args.memberId) return fail('not on loan to member');

    const loan = member.loans[idx];
    const late = Math.max(0, day - loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
    member.owed += fine;
    member.loans.splice(idx, 1);
    book.loanedTo = null;
    if (book.queue.length > 0) {
      book.readyUntil = day + PICKUP_DAYS;
    } else {
      book.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObject(args) || !isId(args.memberId) || !isId(args.bookId)) return fail('invalid arguments');
    const day = admit(args.date);
    if (day === null) return fail('invalid or out-of-order date');
    const member = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!member || !book) return fail('not found');
    const loan = member.loans.find((l) => l.bookId === args.bookId);
    if (!loan) return fail('not on loan to member');
    if (day > loan.dueDay) return fail('overdue');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (book.queue.length > 0) return fail('someone is waiting');
    if (member.owed >= DEBT_LIMIT) return fail('debt limit');

    loan.dueDay += RENEW_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDay) };
  }

  function placeHold(args) {
    if (!isObject(args) || !isId(args.memberId) || !isId(args.bookId)) return fail('invalid arguments');
    const day = admit(args.date);
    if (day === null) return fail('invalid or out-of-order date');
    const member = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!member || !book) return fail('not found');
    if (book.loanedTo === null && book.readyUntil === null) return fail('book is available');
    if (book.loanedTo === args.memberId) return fail('already on loan to member');
    if (book.queue.some((e) => e.memberId === args.memberId)) return fail('already holds this book');

    book.queue.push({ memberId: args.memberId, seq: nextSeq++ });
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    if (!isObject(args) || !isId(args.memberId) || !Number.isInteger(args.amount)) {
      return fail('invalid arguments');
    }
    const day = admit(args.date);
    if (day === null) return fail('invalid or out-of-order date');
    const member = members.get(args.memberId);
    if (!member) return fail('not found');
    if (args.amount < 1) return fail('amount too small');
    if (args.amount > member.owed) return fail('overpayment');

    member.owed -= args.amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    if (!isObject(args) || !isId(args.memberId)) return fail('invalid arguments');
    const day = admit(args.date);
    if (day === null) return fail('invalid or out-of-order date');
    const member = members.get(args.memberId);
    if (!member) return fail('not found');

    const loans = member.loans.map((l) => ({
      bookId: l.bookId,
      dueDate: formatDate(l.dueDay),
    }));

    const found = [];
    for (const [bookId, book] of books) {
      book.queue.forEach((entry, i) => {
        if (entry.memberId === args.memberId) {
          const setAsideForMember =
            i === 0 && book.loanedTo === null && book.readyUntil !== null;
          found.push({
            seq: entry.seq,
            bookId,
            position: i + 1,
            readyUntil: setAsideForMember ? formatDate(book.readyUntil) : null,
          });
        }
      });
    }
    found.sort((a, b) => a.seq - b.seq);
    const holds = found.map((h) => ({
      bookId: h.bookId,
      position: h.position,
      readyUntil: h.readyUntil,
    }));

    return { loans, owed: member.owed, holds };
  }

  const safe = (fn) => (args) => {
    try {
      return fn(args);
    } catch (e) {
      return fail('invalid arguments');
    }
  };

  return {
    addBook: safe(addBook),
    addMember: safe(addMember),
    borrow: safe(borrow),
    returnBook: safe(returnBook),
    renew: safe(renew),
    placeHold: safe(placeHold),
    payFine: safe(payFine),
    getMember: safe(getMember),
  };
}
