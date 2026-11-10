const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const OWED_BLOCK = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  const t = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return t[m - 1];
}

// Pure integer UTC day arithmetic (proleptic Gregorian), no time zones involved.
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
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
  let y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  return [y, m, d];
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function formatDate(n) {
  const [y, m, d] = civilFromDays(n);
  return (
    String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0')
  );
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function getArgs(args) {
  return typeof args === 'object' && args !== null ? args : null;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map(); // bookId -> { state, loanMember, queue: [hold], readyUntil }
  const members = new Map(); // memberId -> { loans: [loan], owed, holds: [hold] }
  const asideBooks = new Set(); // book records currently set aside
  let currentDay = null;

  function removeHoldFromMember(hold) {
    const m = members.get(hold.memberId);
    if (!m) return;
    const i = m.holds.indexOf(hold);
    if (i !== -1) m.holds.splice(i, 1);
  }

  function processExpiry(day) {
    for (const book of Array.from(asideBooks)) {
      while (book.state === 'aside' && day > book.readyUntil) {
        const hold = book.queue.shift();
        if (hold) removeHoldFromMember(hold);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.readyUntil = null;
          asideBooks.delete(book);
        }
      }
    }
  }

  // Validates the date, enforces the clock, advances it and runs expiry.
  // Returns the day number, or null if the call must fail on the date.
  function clock(a) {
    if (!a) return null;
    let raw;
    try {
      raw = a.date;
    } catch {
      return null;
    }
    const day = parseDate(raw);
    if (day === null) return null;
    if (currentDay !== null && day < currentDay) return null;
    currentDay = day;
    processExpiry(day);
    return day;
  }

  function read(a, key) {
    try {
      return a[key];
    } catch {
      return undefined;
    }
  }

  function addBook(args) {
    const a = getArgs(args);
    if (!a) return fail('invalid');
    const bookId = read(a, 'bookId');
    if (!isId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('duplicate');
    books.set(bookId, {
      bookId,
      state: 'available',
      loanMember: null,
      queue: [],
      readyUntil: null,
    });
    return { ok: true };
  }

  function addMember(args) {
    const a = getArgs(args);
    if (!a) return fail('invalid');
    const memberId = read(a, 'memberId');
    if (!isId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('duplicate');
    members.set(memberId, { memberId, loans: [], owed: 0, holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const a = getArgs(args);
    const day = clock(a);
    if (day === null) return fail('invalid date');
    const memberId = read(a, 'memberId');
    const bookId = read(a, 'bookId');
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown');
    if (book.state === 'loan') return fail('on loan');
    if (book.state === 'aside' && book.queue[0].memberId !== memberId) return fail('set aside');
    if (member.loans.length >= MAX_LOANS) return fail('loan limit');
    if (member.loans.some((l) => l.due < day)) return fail('overdue');
    if (member.owed >= OWED_BLOCK) return fail('owes');

    if (book.state === 'aside') {
      const hold = book.queue.shift();
      removeHoldFromMember(hold);
      asideBooks.delete(book);
      book.readyUntil = null;
    }
    const due = day + LOAN_DAYS;
    book.state = 'loan';
    book.loanMember = memberId;
    member.loans.push({ bookId, due, renewals: 0 });
    return { ok: true, dueDate: formatDate(due) };
  }

  function returnBook(args) {
    const a = getArgs(args);
    const day = clock(a);
    if (day === null) return fail('invalid date');
    const memberId = read(a, 'memberId');
    const bookId = read(a, 'bookId');
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown');
    if (book.state !== 'loan' || book.loanMember !== memberId) return fail('not on loan');
    const idx = member.loans.findIndex((l) => l.bookId === bookId);
    if (idx === -1) return fail('not on loan');
    const loan = member.loans[idx];

    const daysLate = Math.max(0, day - loan.due);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
    member.owed += fine;
    member.loans.splice(idx, 1);
    book.loanMember = null;
    if (book.queue.length === 0) {
      book.state = 'available';
      book.readyUntil = null;
    } else {
      book.state = 'aside';
      book.readyUntil = day + PICKUP_DAYS;
      asideBooks.add(book);
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const a = getArgs(args);
    const day = clock(a);
    if (day === null) return fail('invalid date');
    const memberId = read(a, 'memberId');
    const bookId = read(a, 'bookId');
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown');
    if (book.state !== 'loan' || book.loanMember !== memberId) return fail('not on loan');
    const loan = member.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('not on loan');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (day > loan.due) return fail('overdue');
    if (book.queue.length > 0) return fail('holds exist');
    loan.due = day + RENEW_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.due) };
  }

  function placeHold(args) {
    const a = getArgs(args);
    const day = clock(a);
    if (day === null) return fail('invalid date');
    const memberId = read(a, 'memberId');
    const bookId = read(a, 'bookId');
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown');
    if (book.state === 'available') return fail('available');
    if (book.state === 'loan' && book.loanMember === memberId) return fail('own loan');
    if (book.queue.some((h) => h.memberId === memberId)) return fail('already held');
    if (member.holds.length >= MAX_HOLDS) return fail('hold limit');
    const hold = { memberId, bookId };
    book.queue.push(hold);
    member.holds.push(hold);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    const a = getArgs(args);
    const day = clock(a);
    if (day === null) return fail('invalid date');
    const memberId = read(a, 'memberId');
    const amount = read(a, 'amount');
    if (!isId(memberId)) return fail('invalid');
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
      return fail('invalid amount');
    }
    const member = members.get(memberId);
    if (!member) return fail('unknown');
    if (amount > member.owed) return fail('overpayment');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const a = getArgs(args);
    const day = clock(a);
    if (day === null) return fail('invalid date');
    const memberId = read(a, 'memberId');
    if (!isId(memberId)) return fail('invalid');
    const member = members.get(memberId);
    if (!member) return fail('unknown');
    const loans = member.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.due) }));
    const holds = member.holds.map((h) => {
      const book = books.get(h.bookId);
      const idx = book.queue.indexOf(h);
      const ready = book.state === 'aside' && idx === 0;
      return {
        bookId: h.bookId,
        position: idx + 1,
        readyUntil: ready ? formatDate(book.readyUntil) : null,
      };
    });
    return { ok: true, loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
