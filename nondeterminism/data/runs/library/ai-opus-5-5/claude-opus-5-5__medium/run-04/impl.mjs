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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

// Pure UTC civil-day arithmetic (no time zones involved).
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
  return { y, m, d };
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
  const { y, m, d } = civilFromDays(n);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { state, loanMember, queue: [hold], readyUntil }
  const members = new Map(); // memberId -> { loans: [loan], holds: [hold], owed }
  const asideBooks = new Set(); // bookIds currently set aside
  let current = null;

  function processExpiry(today) {
    for (const bookId of Array.from(asideBooks)) {
      const book = books.get(bookId);
      while (book.state === 'aside' && today > book.readyUntil) {
        const hold = book.queue.shift();
        const m = members.get(hold.memberId);
        const idx = m.holds.indexOf(hold);
        if (idx >= 0) m.holds.splice(idx, 1);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.readyUntil = null;
          asideBooks.delete(bookId);
        }
      }
    }
  }

  // Returns the day number, or null if the call must fail on date grounds.
  function tick(args) {
    if (args === null || typeof args !== 'object') return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    processExpiry(day);
    return day;
  }

  function setAsideOrRelease(book, bookId, day) {
    if (book.queue.length > 0) {
      book.state = 'aside';
      book.readyUntil = day + PICKUP_DAYS;
      asideBooks.add(bookId);
    } else {
      book.state = 'available';
      book.readyUntil = null;
    }
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return fail('invalid');
      const { bookId } = args;
      if (!isId(bookId)) return fail('invalid');
      if (books.has(bookId)) return fail('exists');
      books.set(bookId, { state: 'available', loanMember: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      if (args === null || typeof args !== 'object') return fail('invalid');
      const { memberId } = args;
      if (!isId(memberId)) return fail('invalid');
      if (members.has(memberId)) return fail('exists');
      members.set(memberId, { loans: [], holds: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      const day = tick(args);
      if (day === null) return fail('invalid');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid');
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m || !book) return fail('unknown');
      if (book.state === 'loan') return fail('on loan');
      if (book.state === 'aside' && book.queue[0].memberId !== memberId) return fail('set aside');
      if (m.loans.length >= MAX_LOANS) return fail('loan limit');
      if (m.loans.some((l) => l.dueDay < day)) return fail('overdue');
      if (m.owed >= BLOCK_OWED) return fail('owed');

      if (book.state === 'aside') {
        const hold = book.queue.shift();
        const idx = m.holds.indexOf(hold);
        if (idx >= 0) m.holds.splice(idx, 1);
        asideBooks.delete(bookId);
        book.readyUntil = null;
      }
      const dueDay = day + LOAN_DAYS;
      book.state = 'loan';
      book.loanMember = memberId;
      m.loans.push({ bookId, dueDay, renewals: 0 });
      return { ok: true, dueDate: formatDate(dueDay) };
    },

    returnBook(args) {
      const day = tick(args);
      if (day === null) return fail('invalid');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid');
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m || !book) return fail('unknown');
      if (book.state !== 'loan' || book.loanMember !== memberId) return fail('not on loan');
      const idx = m.loans.findIndex((l) => l.bookId === bookId);
      if (idx < 0) return fail('not on loan');
      const loan = m.loans[idx];
      const daysLate = Math.max(0, day - loan.dueDay);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
      m.owed += fine;
      m.loans.splice(idx, 1);
      book.loanMember = null;
      setAsideOrRelease(book, bookId, day);
      return { ok: true, fine };
    },

    renew(args) {
      const day = tick(args);
      if (day === null) return fail('invalid');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid');
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m || !book) return fail('unknown');
      if (book.state !== 'loan' || book.loanMember !== memberId) return fail('not on loan');
      const loan = m.loans.find((l) => l.bookId === bookId);
      if (!loan) return fail('not on loan');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (day > loan.dueDay) return fail('overdue');
      if (book.queue.length > 0) return fail('holds exist');
      loan.dueDay = day + RENEW_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(loan.dueDay) };
    },

    placeHold(args) {
      const day = tick(args);
      if (day === null) return fail('invalid');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid');
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m || !book) return fail('unknown');
      if (book.state === 'available') return fail('available');
      if (book.state === 'loan' && book.loanMember === memberId) return fail('own loan');
      if (book.queue.some((h) => h.memberId === memberId)) return fail('duplicate');
      if (m.holds.length >= MAX_HOLDS) return fail('hold limit');
      const hold = { memberId, bookId };
      book.queue.push(hold);
      m.holds.push(hold);
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      const day = tick(args);
      if (day === null) return fail('invalid');
      const { memberId, amount } = args;
      if (!isId(memberId)) return fail('invalid');
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return fail('invalid');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (amount > m.owed) return fail('overpayment');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const day = tick(args);
      if (day === null) return fail('invalid');
      const { memberId } = args;
      if (!isId(memberId)) return fail('invalid');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.dueDay) }));
      const holds = m.holds.map((h) => {
        const book = books.get(h.bookId);
        const idx = book.queue.indexOf(h);
        const ready = book.state === 'aside' && idx === 0;
        return {
          bookId: h.bookId,
          position: idx + 1,
          readyUntil: ready ? formatDate(book.readyUntil) : null,
        };
      });
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
