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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Pure integer civil-date arithmetic (proleptic Gregorian, UTC-equivalent, no time zones).
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
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
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
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function argObj(a) {
  return typeof a === 'object' && a !== null ? a : null;
}

const FAIL = () => ({ ok: false });

export function createLibrary() {
  const books = new Map();   // bookId -> { loanedTo, queue: [{ memberId, seq }], readyUntil }
  const members = new Map(); // memberId -> { loans: Map(bookId -> { due, renewals }), owed }
  let current = null;
  let holdSeq = 0;

  function expire(day) {
    for (const book of books.values()) {
      while (book.loanedTo === null && book.queue.length > 0 && day > book.readyUntil) {
        const prev = book.readyUntil;
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns day number if the clock accepts the date, else null.
  function tick(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    expire(day);
    return day;
  }

  function memberHolds(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      book.queue.forEach((h, i) => {
        if (h.memberId === memberId) {
          out.push({
            bookId,
            position: i + 1,
            readyUntil: i === 0 && book.loanedTo === null ? formatDate(book.readyUntil) : null,
            seq: h.seq,
          });
        }
      });
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  function prep(args, needBook) {
    const a = argObj(args);
    if (!a) return null;
    const day = tick(a.date);
    if (day === null) return null;
    if (!isId(a.memberId)) return null;
    if (needBook && !isId(a.bookId)) return null;
    const member = members.get(a.memberId);
    if (!member) return null;
    let book = null;
    if (needBook) {
      book = books.get(a.bookId);
      if (!book) return null;
    }
    return { a, day, member, book };
  }

  return {
    addBook(args) {
      const a = argObj(args);
      if (!a || !isId(a.bookId) || books.has(a.bookId)) return FAIL();
      books.set(a.bookId, { loanedTo: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      const a = argObj(args);
      if (!a || !isId(a.memberId) || members.has(a.memberId)) return FAIL();
      members.set(a.memberId, { loans: new Map(), owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      const p = prep(args, true);
      if (!p) return FAIL();
      const { a, day, member, book } = p;
      if (book.loanedTo !== null) return FAIL();
      const setAside = book.queue.length > 0;
      if (setAside && book.queue[0].memberId !== a.memberId) return FAIL();
      if (member.loans.size >= MAX_LOANS) return FAIL();
      for (const loan of member.loans.values()) if (loan.due < day) return FAIL();
      if (member.owed >= OWED_BLOCK) return FAIL();
      if (setAside) book.queue.shift();
      book.readyUntil = null;
      book.loanedTo = a.memberId;
      const due = day + LOAN_DAYS;
      member.loans.set(a.bookId, { due, renewals: 0 });
      return { ok: true, dueDate: formatDate(due) };
    },

    returnBook(args) {
      const p = prep(args, true);
      if (!p) return FAIL();
      const { a, day, member, book } = p;
      if (book.loanedTo !== a.memberId) return FAIL();
      const loan = member.loans.get(a.bookId);
      if (!loan) return FAIL();
      const daysLate = Math.max(0, day - loan.due);
      const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
      member.owed += fine;
      member.loans.delete(a.bookId);
      book.loanedTo = null;
      book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
      return { ok: true, fine };
    },

    renew(args) {
      const p = prep(args, true);
      if (!p) return FAIL();
      const { a, day, member, book } = p;
      if (book.loanedTo !== a.memberId) return FAIL();
      const loan = member.loans.get(a.bookId);
      if (!loan) return FAIL();
      if (loan.renewals >= MAX_RENEWALS) return FAIL();
      if (day > loan.due) return FAIL();
      if (book.queue.length > 0) return FAIL();
      loan.due = Math.max(loan.due, day + RENEW_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(loan.due) };
    },

    placeHold(args) {
      const p = prep(args, true);
      if (!p) return FAIL();
      const { a, book, member } = p;
      if (book.loanedTo === null && book.queue.length === 0) return FAIL();
      if (book.loanedTo === a.memberId || member.loans.has(a.bookId)) return FAIL();
      if (book.queue.some((h) => h.memberId === a.memberId)) return FAIL();
      if (memberHolds(a.memberId).length >= MAX_HOLDS) return FAIL();
      book.queue.push({ memberId: a.memberId, seq: ++holdSeq });
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      const p = prep(args, false);
      if (!p) return FAIL();
      const { a, member } = p;
      const amount = a.amount;
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return FAIL();
      if (amount > member.owed) return FAIL();
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember(args) {
      const p = prep(args, false);
      if (!p) return FAIL();
      const { a, member } = p;
      const loans = [];
      for (const [bookId, loan] of member.loans) loans.push({ bookId, dueDate: formatDate(loan.due) });
      const holds = memberHolds(a.memberId).map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
