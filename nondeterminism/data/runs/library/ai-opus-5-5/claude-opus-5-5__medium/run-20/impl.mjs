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
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

// Pure proleptic-Gregorian (UTC-equivalent) day arithmetic; no time zones involved.
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
    String(y).padStart(4, '0') + '-' +
    String(m).padStart(2, '0') + '-' +
    String(d).padStart(2, '0')
  );
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function getArgs(a) {
  if (a === null || typeof a !== 'object') return null;
  return a;
}

const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { loanedTo: memberId|null, queue: [{memberId, seq}], readyUntil: dayNum|null }
  const members = new Map(); // memberId -> { loans: [{ bookId, due, renewals }], owed }
  let currentDay = null;
  let holdSeq = 0;

  function processExpiry(day) {
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

  // Validates the date against the clock, advances the clock, processes expiry.
  // Returns the day number, or null if the call must fail with no effect.
  function enterDated(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (currentDay !== null && day < currentDay) return null;
    currentDay = day;
    processExpiry(day);
    return day;
  }

  function activeHoldCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      for (const h of book.queue) if (h.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook(args) {
      const a = getArgs(args);
      if (!a || !isId(a.bookId)) return FAIL('invalid');
      if (books.has(a.bookId)) return FAIL('exists');
      books.set(a.bookId, { loanedTo: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      const a = getArgs(args);
      if (!a || !isId(a.memberId)) return FAIL('invalid');
      if (members.has(a.memberId)) return FAIL('exists');
      members.set(a.memberId, { loans: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      const a = getArgs(args);
      if (!a || !isId(a.memberId) || !isId(a.bookId) || parseDate(a.date) === null) return FAIL('invalid');
      const day = enterDated(a.date);
      if (day === null) return FAIL('date');
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL('unknown');
      if (book.loanedTo !== null) return FAIL('on loan');
      const setAsideFor = book.queue.length > 0 ? book.queue[0].memberId : null;
      if (setAsideFor !== null && setAsideFor !== a.memberId) return FAIL('set aside');
      if (member.loans.length >= MAX_LOANS) return FAIL('loan limit');
      if (member.loans.some((l) => l.due < day)) return FAIL('overdue');
      if (member.owed >= OWED_BLOCK) return FAIL('owed');
      if (setAsideFor !== null) {
        book.queue.shift();
      }
      book.readyUntil = null;
      book.loanedTo = a.memberId;
      const due = day + LOAN_DAYS;
      member.loans.push({ bookId: a.bookId, due, renewals: 0 });
      return { ok: true, dueDate: formatDate(due) };
    },

    returnBook(args) {
      const a = getArgs(args);
      if (!a || !isId(a.memberId) || !isId(a.bookId) || parseDate(a.date) === null) return FAIL('invalid');
      const day = enterDated(a.date);
      if (day === null) return FAIL('date');
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL('unknown');
      if (book.loanedTo !== a.memberId) return FAIL('not on loan to member');
      const idx = member.loans.findIndex((l) => l.bookId === a.bookId);
      if (idx < 0) return FAIL('not on loan to member');
      const loan = member.loans[idx];
      const daysLate = Math.max(0, day - loan.due);
      const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
      member.owed += fine;
      member.loans.splice(idx, 1);
      book.loanedTo = null;
      if (book.queue.length > 0) {
        book.readyUntil = day + PICKUP_DAYS;
      } else {
        book.readyUntil = null;
      }
      return { ok: true, fine };
    },

    renew(args) {
      const a = getArgs(args);
      if (!a || !isId(a.memberId) || !isId(a.bookId) || parseDate(a.date) === null) return FAIL('invalid');
      const day = enterDated(a.date);
      if (day === null) return FAIL('date');
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL('unknown');
      if (book.loanedTo !== a.memberId) return FAIL('not on loan to member');
      const loan = member.loans.find((l) => l.bookId === a.bookId);
      if (!loan) return FAIL('not on loan to member');
      if (loan.renewals >= MAX_RENEWALS) return FAIL('renewal limit');
      if (day > loan.due) return FAIL('overdue');
      if (book.queue.length > 0) return FAIL('holds exist');
      loan.due = Math.max(loan.due, day + RENEW_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(loan.due) };
    },

    placeHold(args) {
      const a = getArgs(args);
      if (!a || !isId(a.memberId) || !isId(a.bookId) || parseDate(a.date) === null) return FAIL('invalid');
      const day = enterDated(a.date);
      if (day === null) return FAIL('date');
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL('unknown');
      if (book.loanedTo === null && book.queue.length === 0) return FAIL('available');
      if (book.loanedTo === a.memberId) return FAIL('member has book');
      if (book.queue.some((h) => h.memberId === a.memberId)) return FAIL('duplicate hold');
      if (activeHoldCount(a.memberId) >= MAX_HOLDS) return FAIL('hold limit');
      book.queue.push({ memberId: a.memberId, seq: ++holdSeq });
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      const a = getArgs(args);
      if (!a || !isId(a.memberId) || parseDate(a.date) === null) return FAIL('invalid');
      if (typeof a.amount !== 'number' || !Number.isSafeInteger(a.amount) || a.amount <= 0) return FAIL('invalid');
      const day = enterDated(a.date);
      if (day === null) return FAIL('date');
      const member = members.get(a.memberId);
      if (!member) return FAIL('unknown');
      if (a.amount > member.owed) return FAIL('overpayment');
      member.owed -= a.amount;
      return { ok: true, owed: member.owed };
    },

    getMember(args) {
      const a = getArgs(args);
      if (!a || !isId(a.memberId) || parseDate(a.date) === null) return FAIL('invalid');
      const day = enterDated(a.date);
      if (day === null) return FAIL('date');
      const member = members.get(a.memberId);
      if (!member) return FAIL('unknown');
      const loans = member.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.due) }));
      const found = [];
      for (const [bookId, book] of books) {
        book.queue.forEach((h, i) => {
          if (h.memberId === a.memberId) {
            const ready = i === 0 && book.loanedTo === null;
            found.push({
              seq: h.seq,
              bookId,
              position: i + 1,
              readyUntil: ready ? formatDate(book.readyUntil) : null,
            });
          }
        });
      }
      found.sort((x, y) => x.seq - y.seq);
      const holds = found.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
