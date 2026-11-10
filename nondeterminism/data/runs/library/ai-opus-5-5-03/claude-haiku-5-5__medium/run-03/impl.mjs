const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const MAX_DATE = '9999-12-31';
const MS_PER_DAY = 86400000;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  const days = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[m - 1];
}

// Returns the day number (days since 1970-01-01, UTC) for a valid date string, else null.
function toDayNumber(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / MS_PER_DAY);
}

function fromDayNumber(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isValidDate(s) {
  return toDayNumber(s) !== null;
}

// Number of calendar days from a to b.
function diff(a, b) {
  return toDayNumber(b) - toDayNumber(a);
}

// Adds n days to a date string. Results past 9999-12-31 are clamped to 9999-12-31.
function addDays(s, n) {
  let x = toDayNumber(s) + n;
  const max = toDayNumber(MAX_DATE);
  if (x > max) x = max;
  return fromDayNumber(x);
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isAmount(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function isArgObject(a) {
  return a !== null && typeof a === 'object' && !Array.isArray(a);
}

function bad() {
  return { ok: false };
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDate, renewals }, queue: [hold] }
  // hold -> { memberId, seq, ready, readyUntil }
  const books = new Map();
  // memberId -> { loanBookIds: [bookId in borrow order], owed: integer cents }
  const members = new Map();
  let clock = null;
  let holdSeq = 0;

  // Section 5: pickup expiry, applied to every book for date D.
  function processHolds(D) {
    for (const book of books.values()) {
      const q = book.queue;
      while (q.length > 0 && q[0].ready && q[0].readyUntil < D) {
        const old = q.shift();
        const E = addDays(old.readyUntil, 1);
        if (q.length > 0) {
          q[0].ready = true;
          q[0].readyUntil = addDays(E, PICKUP_DAYS);
        }
      }
    }
  }

  // Section 4.4: returns false if the date is earlier than the clock.
  function advanceClock(date) {
    if (clock !== null && date < clock) return false;
    clock = date;
    processHolds(date);
    return true;
  }

  function guarded(fn) {
    return (arg) => {
      try {
        return fn(arg);
      } catch {
        return bad();
      }
    };
  }

  function addBook(arg) {
    if (!isArgObject(arg)) return bad();
    const bookId = arg.bookId;
    if (!isId(bookId) || books.has(bookId)) return bad();
    books.set(bookId, { loan: null, queue: [] });
    return { ok: true };
  }

  function addMember(arg) {
    if (!isArgObject(arg)) return bad();
    const memberId = arg.memberId;
    if (!isId(memberId) || members.has(memberId)) return bad();
    members.set(memberId, { loanBookIds: [], owed: 0 });
    return { ok: true };
  }

  function borrow(arg) {
    if (!isArgObject(arg)) return bad();
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const date = arg.date;
    if (!isId(memberId) || !isId(bookId) || !isValidDate(date)) return bad();
    if (!advanceClock(date)) return bad();

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return bad();
    if (book.loan) return bad();

    const head = book.queue[0];
    if (head && head.ready && head.memberId !== memberId) return bad();
    if (member.loanBookIds.length >= MAX_LOANS) return bad();
    if (member.owed >= BORROW_BLOCK_OWED) return bad();

    const dueDate = addDays(date, LOAN_DAYS);
    if (head && head.ready) {
      // This member's own ready hold is consumed; the rest stay waiting.
      book.queue.shift();
    }
    book.loan = { memberId, dueDate, renewals: 0 };
    member.loanBookIds.push(bookId);
    return { ok: true, dueDate };
  }

  function returnBook(arg) {
    if (!isArgObject(arg)) return bad();
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const date = arg.date;
    if (!isId(memberId) || !isId(bookId) || !isValidDate(date)) return bad();
    if (!advanceClock(date)) return bad();

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return bad();
    if (!book.loan || book.loan.memberId !== memberId) return bad();

    const daysLate = diff(book.loan.dueDate, date);
    const fine = daysLate <= GRACE_DAYS
      ? 0
      : Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);

    member.owed += fine;
    member.loanBookIds = member.loanBookIds.filter((id) => id !== bookId);
    book.loan = null;

    if (book.queue.length > 0) {
      const head = book.queue[0];
      head.ready = true;
      head.readyUntil = addDays(date, PICKUP_DAYS);
    }
    return { ok: true, fine };
  }

  function renew(arg) {
    if (!isArgObject(arg)) return bad();
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const date = arg.date;
    if (!isId(memberId) || !isId(bookId) || !isValidDate(date)) return bad();
    if (!advanceClock(date)) return bad();

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return bad();
    if (!book.loan || book.loan.memberId !== memberId) return bad();
    if (date > book.loan.dueDate) return bad();
    if (book.loan.renewals >= MAX_RENEWALS) return bad();
    if (book.queue.length > 0) return bad();

    const dueDate = addDays(book.loan.dueDate, LOAN_DAYS);
    book.loan.dueDate = dueDate;
    book.loan.renewals += 1;
    return { ok: true, dueDate };
  }

  function placeHold(arg) {
    if (!isArgObject(arg)) return bad();
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const date = arg.date;
    if (!isId(memberId) || !isId(bookId) || !isValidDate(date)) return bad();
    if (!advanceClock(date)) return bad();

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return bad();
    // Available: no loan and empty queue.
    if (!book.loan && book.queue.length === 0) return bad();
    if (book.loan && book.loan.memberId === memberId) return bad();
    if (book.queue.some((h) => h.memberId === memberId)) return bad();

    book.queue.push({ memberId, seq: holdSeq++, ready: false, readyUntil: null });
    return { ok: true, position: book.queue.length };
  }

  function payFine(arg) {
    if (!isArgObject(arg)) return bad();
    const memberId = arg.memberId;
    const amount = arg.amount;
    const date = arg.date;
    if (!isId(memberId) || !isAmount(amount) || !isValidDate(date)) return bad();
    if (!advanceClock(date)) return bad();

    const member = members.get(memberId);
    if (!member) return bad();
    if (amount > member.owed) return bad();

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(arg) {
    if (!isArgObject(arg)) return bad();
    const memberId = arg.memberId;
    const date = arg.date;
    if (!isId(memberId) || !isValidDate(date)) return bad();
    if (!advanceClock(date)) return bad();

    const member = members.get(memberId);
    if (!member) return bad();

    const loans = member.loanBookIds.map((bookId) => ({
      bookId,
      dueDate: books.get(bookId).loan.dueDate,
    }));

    const found = [];
    for (const [bookId, book] of books) {
      book.queue.forEach((h, index) => {
        if (h.memberId === memberId) {
          found.push({
            seq: h.seq,
            bookId,
            position: index + 1,
            readyUntil: h.ready ? h.readyUntil : null,
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

    return { ok: true, loans, owed: member.owed, holds };
  }

  return {
    addBook: guarded(addBook),
    addMember: guarded(addMember),
    borrow: guarded(borrow),
    returnBook: guarded(returnBook),
    renew: guarded(renew),
    placeHold: guarded(placeHold),
    payFine: guarded(payFine),
    getMember: guarded(getMember),
  };
}
