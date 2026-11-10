const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_RATE = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const OWED_BLOCK = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function daysInMonth(y, m) {
  if (m === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function toDayNum(y, m, d) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return Math.round(dt.getTime() / DAY_MS);
}

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return toDayNum(y, m, d);
}

const MAX_DAY = toDayNum(9999, 12, 31);

function formatDay(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { id, loan, queue, readyUntil }
  const members = new Map(); // memberId -> { id, loans: [bookId], holds: [hold], owed }
  let currentDay = null;
  let holdSeq = 0;

  function isSetAside(book) {
    return book.loan === null && book.queue.length > 0;
  }

  function removeHoldFromMember(hold) {
    const m = members.get(hold.memberId);
    const i = m.holds.indexOf(hold);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function processExpiry(day) {
    for (const book of books.values()) {
      while (isSetAside(book) && day > book.readyUntil) {
        const prevUntil = book.readyUntil;
        const hold = book.queue.shift();
        removeHoldFromMember(hold);
        if (book.queue.length > 0) {
          book.readyUntil = Math.min(prevUntil + 1 + PICKUP_DAYS, MAX_DAY);
          if (book.readyUntil === prevUntil) {
            // Cannot advance beyond the calendar limit; stop to avoid looping.
            break;
          }
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates argument shape. Returns day number, or null on invalid input/earlier date.
  // On success advances the clock and processes expiry.
  function begin(args, idFields) {
    if (args === null || typeof args !== 'object') return null;
    for (const f of idFields) if (!isId(args[f])) return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (currentDay !== null && day < currentDay) return null;
    currentDay = day;
    processExpiry(day);
    return day;
  }

  function addBook(args) {
    if (args === null || typeof args !== 'object' || !isId(args.bookId)) return fail('invalid');
    if (books.has(args.bookId)) return fail('exists');
    books.set(args.bookId, { id: args.bookId, loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (args === null || typeof args !== 'object' || !isId(args.memberId)) return fail('invalid');
    if (members.has(args.memberId)) return fail('exists');
    members.set(args.memberId, { id: args.memberId, loans: [], holds: [], owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    const day = begin(args, ['memberId', 'bookId']);
    if (day === null) return fail('invalid');
    const member = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan !== null) return fail('on loan');
    const setAside = isSetAside(book);
    if (setAside && book.queue[0].memberId !== member.id) return fail('set aside for another');
    if (member.loans.length >= MAX_LOANS) return fail('too many loans');
    for (const bid of member.loans) {
      if (books.get(bid).loan.dueDay < day) return fail('overdue loan');
    }
    if (member.owed >= OWED_BLOCK) return fail('owes too much');
    const dueDay = day + LOAN_DAYS;
    if (dueDay > MAX_DAY) return fail('date out of range');
    if (setAside) {
      const hold = book.queue.shift();
      removeHoldFromMember(hold);
      book.readyUntil = null;
    }
    book.loan = { memberId: member.id, dueDay, renewals: 0 };
    member.loans.push(book.id);
    return { ok: true, dueDate: formatDay(dueDay) };
  }

  function returnBook(args) {
    const day = begin(args, ['memberId', 'bookId']);
    if (day === null) return fail('invalid');
    const member = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan === null || book.loan.memberId !== member.id) return fail('not on loan to member');
    const daysLate = Math.max(0, day - book.loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    member.owed += fine;
    book.loan = null;
    member.loans.splice(member.loans.indexOf(book.id), 1);
    if (book.queue.length > 0) {
      book.readyUntil = Math.min(day + PICKUP_DAYS, MAX_DAY);
    } else {
      book.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const day = begin(args, ['memberId', 'bookId']);
    if (day === null) return fail('invalid');
    const member = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan === null || book.loan.memberId !== member.id) return fail('not on loan to member');
    if (book.loan.renewals >= MAX_RENEWALS) return fail('max renewals');
    if (day > book.loan.dueDay) return fail('overdue');
    if (book.queue.length > 0) return fail('holds waiting');
    const dueDay = day + RENEW_DAYS;
    if (dueDay > MAX_DAY) return fail('date out of range');
    book.loan.dueDay = dueDay;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDay(dueDay) };
  }

  function placeHold(args) {
    const day = begin(args, ['memberId', 'bookId']);
    if (day === null) return fail('invalid');
    const member = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan === null && book.queue.length === 0) return fail('available');
    if (book.loan !== null && book.loan.memberId === member.id) return fail('member has it');
    if (book.queue.some((h) => h.memberId === member.id)) return fail('already holding');
    if (member.holds.length >= MAX_HOLDS) return fail('too many holds');
    const hold = { memberId: member.id, bookId: book.id, seq: ++holdSeq };
    book.queue.push(hold);
    member.holds.push(hold);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    const day = begin(args, ['memberId']);
    if (day === null) return fail('invalid');
    const amount = args.amount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
      return fail('invalid amount');
    }
    const member = members.get(args.memberId);
    if (!member) return fail('unknown');
    if (amount > member.owed) return fail('overpayment');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const day = begin(args, ['memberId']);
    if (day === null) return fail('invalid');
    const member = members.get(args.memberId);
    if (!member) return fail('unknown');
    const loans = member.loans.map((bid) => ({
      bookId: bid,
      dueDate: formatDay(books.get(bid).loan.dueDay),
    }));
    const holds = member.holds.map((h) => {
      const book = books.get(h.bookId);
      const idx = book.queue.indexOf(h);
      const ready = idx === 0 && isSetAside(book);
      return {
        bookId: h.bookId,
        position: idx + 1,
        readyUntil: ready ? formatDay(book.readyUntil) : null,
      };
    });
    return { ok: true, loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
