const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 1000;
const BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const RESET_GAP_DAYS = 8; // 7-day window plus the day after it ended

// Day numbers: days since 1970-01-01 (proleptic Gregorian, UTC-free arithmetic).
function toDayNum(y, m, d) {
  if (m <= 2) y -= 1;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDayNum(n) {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  let y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  return { y, m, d };
}

const MAX_DAY = toDayNum(9999, 12, 31);

function addDays(day, n) {
  return Math.min(day + n, MAX_DAY);
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function fmt(day) {
  const { y, m, d } = fromDayNum(day);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

function daysInMonth(y, m) {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return toDayNum(y, m, d);
}

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function fail(reason) {
  return { ok: false, reason };
}

function guard(fn) {
  try {
    return fn();
  } catch {
    return { ok: false, reason: 'internal error' };
  }
}

export function createLibrary() {
  // bookId -> { id, loan: null | { memberId, dueDay, renewals, seq },
  //             setAside: null | { readyUntil }, queue: [{ memberId, seq }] }
  // queue[0] is the set-aside member whenever setAside is non-null.
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();
  let clock = null;
  let seqCounter = 0;

  // Applies the clock rule and pickup-expiry processing.
  // Returns false if the date is earlier than the current clock.
  function advance(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    for (const book of books.values()) {
      while (book.setAside !== null && clock > book.setAside.readyUntil) {
        book.queue.shift();
        if (book.queue.length === 0) {
          book.setAside = null;
        } else {
          book.setAside = { readyUntil: addDays(book.setAside.readyUntil, RESET_GAP_DAYS) };
        }
      }
    }
    return true;
  }

  function loansOf(memberId) {
    const out = [];
    for (const book of books.values()) {
      if (book.loan !== null && book.loan.memberId === memberId) out.push(book);
    }
    out.sort((a, b) => a.loan.seq - b.loan.seq);
    return out;
  }

  function holdsOf(memberId) {
    const out = [];
    for (const book of books.values()) {
      const idx = book.queue.findIndex((e) => e.memberId === memberId);
      if (idx >= 0) out.push({ book, idx, entry: book.queue[idx] });
    }
    out.sort((a, b) => a.entry.seq - b.entry.seq);
    return out;
  }

  function addBook(input) {
    return guard(() => {
      if (!isObj(input) || !isId(input.bookId)) return fail('invalid bookId');
      if (books.has(input.bookId)) return fail('book exists');
      books.set(input.bookId, { id: input.bookId, loan: null, setAside: null, queue: [] });
      return { ok: true };
    });
  }

  function addMember(input) {
    return guard(() => {
      if (!isObj(input) || !isId(input.memberId)) return fail('invalid memberId');
      if (members.has(input.memberId)) return fail('member exists');
      members.set(input.memberId, { owed: 0 });
      return { ok: true };
    });
  }

  function borrow(input) {
    return guard(() => {
      if (!isObj(input) || !isId(input.memberId) || !isId(input.bookId)) return fail('invalid input');
      const day = parseDate(input.date);
      if (day === null) return fail('invalid date');
      const memberId = input.memberId;
      const bookId = input.bookId;
      if (!advance(day)) return fail('date before clock');
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member) return fail('unknown member or book');
      if (book.loan !== null) return fail('book on loan');
      if (book.setAside !== null && book.queue[0].memberId !== memberId) {
        return fail('set aside for another member');
      }
      if (loansOf(memberId).length >= MAX_LOANS) return fail('loan limit reached');
      if (member.owed >= BLOCK_OWED) return fail('borrowing blocked by fines');
      const dueDay = addDays(day, LOAN_DAYS);
      if (book.setAside !== null) {
        book.queue.shift();
        book.setAside = null;
      }
      book.loan = { memberId, dueDay, renewals: 0, seq: seqCounter++ };
      return { ok: true, dueDate: fmt(dueDay) };
    });
  }

  function renew(input) {
    return guard(() => {
      if (!isObj(input) || !isId(input.memberId) || !isId(input.bookId)) return fail('invalid input');
      const day = parseDate(input.date);
      if (day === null) return fail('invalid date');
      const memberId = input.memberId;
      const bookId = input.bookId;
      if (!advance(day)) return fail('date before clock');
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member) return fail('unknown member or book');
      if (book.loan === null || book.loan.memberId !== memberId) return fail('not on loan to member');
      const loan = book.loan;
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.queue.length > 0) return fail('book has waiting holds');
      if (day > loan.dueDay) return fail('loan overdue');
      const newDue = addDays(day, LOAN_DAYS);
      if (newDue <= loan.dueDay) return fail('renewal does not extend loan');
      loan.dueDay = newDue;
      loan.renewals += 1;
      return { ok: true, dueDate: fmt(newDue) };
    });
  }

  function returnBook(input) {
    return guard(() => {
      if (!isObj(input) || !isId(input.memberId) || !isId(input.bookId)) return fail('invalid input');
      const day = parseDate(input.date);
      if (day === null) return fail('invalid date');
      const memberId = input.memberId;
      const bookId = input.bookId;
      if (!advance(day)) return fail('date before clock');
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member) return fail('unknown member or book');
      if (book.loan === null || book.loan.memberId !== memberId) return fail('not on loan to member');
      const daysLate = day - book.loan.dueDay;
      const chargeable = Math.max(0, daysLate - GRACE_DAYS);
      const fine = Math.min(FINE_PER_DAY * chargeable, MAX_FINE);
      book.loan = null;
      member.owed += fine;
      if (book.queue.length === 0) {
        book.setAside = null;
      } else {
        book.setAside = { readyUntil: addDays(day, PICKUP_DAYS) };
      }
      return { ok: true, fine };
    });
  }

  function placeHold(input) {
    return guard(() => {
      if (!isObj(input) || !isId(input.memberId) || !isId(input.bookId)) return fail('invalid input');
      const day = parseDate(input.date);
      if (day === null) return fail('invalid date');
      const memberId = input.memberId;
      const bookId = input.bookId;
      if (!advance(day)) return fail('date before clock');
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member) return fail('unknown member or book');
      if (book.loan === null && book.setAside === null) return fail('book is available');
      if (book.loan !== null && book.loan.memberId === memberId) return fail('member has this book');
      if (book.queue.some((e) => e.memberId === memberId)) return fail('hold already exists');
      book.queue.push({ memberId, seq: seqCounter++ });
      return { ok: true, position: book.queue.length };
    });
  }

  function payFine(input) {
    return guard(() => {
      if (!isObj(input) || !isId(input.memberId)) return fail('invalid input');
      const amount = input.amount;
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail('invalid amount');
      const day = parseDate(input.date);
      if (day === null) return fail('invalid date');
      const memberId = input.memberId;
      if (!advance(day)) return fail('date before clock');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    });
  }

  function getMember(input) {
    return guard(() => {
      if (!isObj(input) || !isId(input.memberId)) return fail('invalid input');
      const day = parseDate(input.date);
      if (day === null) return fail('invalid date');
      const memberId = input.memberId;
      if (!advance(day)) return fail('date before clock');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const loans = loansOf(memberId).map((b) => ({
        bookId: b.id,
        dueDate: fmt(b.loan.dueDay),
      }));
      const holds = holdsOf(memberId).map(({ book, idx }) => ({
        bookId: book.id,
        position: idx + 1,
        readyUntil: idx === 0 && book.setAside !== null ? fmt(book.setAside.readyUntil) : null,
      }));
      return { ok: true, loans, owed: member.owed, holds };
    });
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
