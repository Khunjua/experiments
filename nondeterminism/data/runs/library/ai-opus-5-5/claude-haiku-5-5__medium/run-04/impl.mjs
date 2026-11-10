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

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

// Proleptic Gregorian day count (days since 1970-01-01), no Date objects.
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const n = daysFromCivil(y, m, d);
  const [yy, mm, dd] = civilFromDays(n);
  if (yy !== y || mm !== m || dd !== d) return null;
  return n;
}

const p2 = (n) => String(n).padStart(2, '0');

function formatDate(n) {
  const [y, m, d] = civilFromDays(n);
  return String(y).padStart(4, '0') + '-' + p2(m) + '-' + p2(d);
}

function removeFirst(arr, v) {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, dueDate, renewals} | null, queue: [memberId], readyUntil: number | null }
  const members = new Map(); // memberId -> { loans: [bookId], holds: [bookId], owed: number }
  let today = null;          // current date as day number, or null if unset

  // Processes hold expiries as of `today` for every book.
  function expire() {
    for (const [bookId, book] of books) {
      if (book.loan !== null) continue;
      while (book.queue.length > 0 && today > book.readyUntil) {
        const memberId = book.queue.shift();
        const member = members.get(memberId);
        if (member) removeFirst(member.holds, bookId);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates a date and advances the clock. Returns the day number, or null
  // when the date is invalid or earlier than the current date (no effect).
  function enter(date) {
    const n = parseDate(date);
    if (n === null) return null;
    if (today !== null && n < today) return null;
    today = n;
    expire();
    return n;
  }

  function fail() {
    return { ok: false };
  }

  function addBook(args) {
    if (!isObj(args) || !isId(args.bookId)) return fail();
    if (books.has(args.bookId)) return fail();
    books.set(args.bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args) || !isId(args.memberId)) return fail();
    if (members.has(args.memberId)) return fail();
    members.set(args.memberId, { loans: [], holds: [], owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
    const now = enter(args.date);
    if (now === null) return fail();
    const { memberId, bookId } = args;
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail();
    if (book.loan !== null) return fail();

    const readyForMe = book.queue.length > 0 && book.queue[0] === memberId;
    if (book.queue.length > 0 && !readyForMe) return fail();

    if (member.loans.length >= MAX_LOANS) return fail();
    for (const id of member.loans) {
      if (books.get(id).loan.dueDate < now) return fail();
    }
    if (member.owed >= BLOCK_OWED) return fail();

    if (readyForMe) {
      book.queue.shift();
      removeFirst(member.holds, bookId);
    }
    book.readyUntil = null;
    const dueDate = now + LOAN_DAYS;
    book.loan = { memberId, dueDate, renewals: 0 };
    member.loans.push(bookId);
    return { ok: true, dueDate: formatDate(dueDate) };
  }

  function returnBook(args) {
    if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
    const now = enter(args.date);
    if (now === null) return fail();
    const { memberId, bookId } = args;
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail();
    if (book.loan === null || book.loan.memberId !== memberId) return fail();

    const daysLate = Math.max(0, now - book.loan.dueDate);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
    member.owed += fine;
    removeFirst(member.loans, bookId);
    book.loan = null;
    if (book.queue.length > 0) {
      book.readyUntil = now + PICKUP_DAYS;
    } else {
      book.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
    const now = enter(args.date);
    if (now === null) return fail();
    const { memberId, bookId } = args;
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail();
    const loan = book.loan;
    if (loan === null || loan.memberId !== memberId) return fail();
    if (loan.renewals >= MAX_RENEWALS) return fail();
    if (now > loan.dueDate) return fail();
    if (book.queue.length > 0) return fail();

    loan.dueDate = now + RENEWAL_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDate) };
  }

  function placeHold(args) {
    if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
    const now = enter(args.date);
    if (now === null) return fail();
    const { memberId, bookId } = args;
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail();

    const available = book.loan === null && book.queue.length === 0;
    if (available) return fail();
    if (book.loan !== null && book.loan.memberId === memberId) return fail();
    if (member.holds.includes(bookId)) return fail();
    if (member.holds.length >= MAX_HOLDS) return fail();

    book.queue.push(memberId);
    member.holds.push(bookId);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    if (!isObj(args) || !isId(args.memberId)) return fail();
    const { memberId, amount } = args;
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail();
    const now = enter(args.date);
    if (now === null) return fail();
    const member = members.get(memberId);
    if (!member) return fail();
    if (amount > member.owed) return fail();

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    if (!isObj(args) || !isId(args.memberId)) return fail();
    const now = enter(args.date);
    if (now === null) return fail();
    const memberId = args.memberId;
    const member = members.get(memberId);
    if (!member) return fail();

    const loans = member.loans.map((bookId) => ({
      bookId,
      dueDate: formatDate(books.get(bookId).loan.dueDate),
    }));

    const holds = member.holds.map((bookId) => {
      const book = books.get(bookId);
      const idx = book.queue.indexOf(memberId);
      const ready = book.loan === null && idx === 0;
      return {
        bookId,
        position: idx + 1,
        readyUntil: ready ? formatDate(book.readyUntil) : null,
      };
    });

    return { ok: true, loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
