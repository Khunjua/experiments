const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 1000;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Days since 1970-01-01 for a proleptic Gregorian calendar date (Howard Hinnant's algorithm).
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// Inverse of daysFromCivil. Returns [year, month, day].
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

// Returns the day number for a valid 'YYYY-MM-DD' string, or null.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const match = DATE_RE.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const n = daysFromCivil(y, m, d);
  const [yy, mm, dd] = civilFromDays(n);
  if (yy !== y || mm !== m || dd !== d) return null;
  return n;
}

function formatDate(n) {
  const [y, m, d] = civilFromDays(n);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function getField(args, key) {
  return args !== null && typeof args === 'object' ? args[key] : undefined;
}

function fail() {
  return { ok: false };
}

function removeHold(member, bookId) {
  const idx = member.holds.indexOf(bookId);
  if (idx >= 0) member.holds.splice(idx, 1);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let latest = null;

  function findBook(bookId) {
    return isId(bookId) ? books.get(bookId) : undefined;
  }

  function findMember(memberId) {
    return isId(memberId) ? members.get(memberId) : undefined;
  }

  // Hold-expiry processing up to day D (section 6.4).
  function expire(D) {
    for (const book of books.values()) {
      while (book.status === 'aside' && book.readyUntil < D) {
        const holder = members.get(book.asideMember);
        if (holder) removeHold(holder, book.id);
        const start = book.readyUntil + 1;
        if (book.queue.length > 0) {
          book.asideMember = book.queue.shift();
          book.readyUntil = start + PICKUP_DAYS;
        } else {
          book.status = 'shelf';
          book.asideMember = null;
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates a dated call's date, enforces ordering, updates latest, runs expiry.
  // Returns the day number, or null if the call must be rejected.
  function beginDated(date) {
    const D = parseDate(date);
    if (D === null) return null;
    if (latest !== null && D < latest) return null;
    latest = D;
    expire(D);
    return D;
  }

  function addBook(args) {
    const bookId = getField(args, 'bookId');
    if (!isId(bookId) || books.has(bookId)) return fail();
    books.set(bookId, {
      id: bookId,
      status: 'shelf',
      loanMember: null,
      asideMember: null,
      readyUntil: null,
      queue: [],
    });
    return { ok: true };
  }

  function addMember(args) {
    const memberId = getField(args, 'memberId');
    if (!isId(memberId) || members.has(memberId)) return fail();
    members.set(memberId, {
      id: memberId,
      owed: 0,
      loans: [],
      holds: [],
    });
    return { ok: true };
  }

  function borrow(args) {
    const memberId = getField(args, 'memberId');
    const bookId = getField(args, 'bookId');
    const D = beginDated(getField(args, 'date'));
    if (D === null) return fail();
    const member = findMember(memberId);
    const book = findBook(bookId);
    if (!member || !book) return fail();
    if (book.status === 'loan') return fail();
    if (book.status === 'aside' && book.asideMember !== memberId) return fail();
    if (book.status === 'shelf' && book.queue.length > 0) return fail();
    if (member.loans.length >= MAX_LOANS) return fail();
    if (member.owed >= BORROW_BLOCK_OWED) return fail();

    if (book.status === 'aside') {
      removeHold(member, bookId);
      book.asideMember = null;
      book.readyUntil = null;
    }
    book.status = 'loan';
    book.loanMember = memberId;
    const dueDate = D + LOAN_DAYS;
    member.loans.push({ bookId, dueDate, renewals: 0 });
    return { ok: true, dueDate: formatDate(dueDate) };
  }

  function returnBook(args) {
    const memberId = getField(args, 'memberId');
    const bookId = getField(args, 'bookId');
    const D = beginDated(getField(args, 'date'));
    if (D === null) return fail();
    const member = findMember(memberId);
    const book = findBook(bookId);
    if (!member || !book) return fail();
    if (book.status !== 'loan' || book.loanMember !== memberId) return fail();

    const idx = member.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return fail();
    const loan = member.loans[idx];

    const daysLate = Math.max(0, D - loan.dueDate);
    const fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
    member.owed += fine;
    member.loans.splice(idx, 1);

    book.loanMember = null;
    if (book.queue.length > 0) {
      book.status = 'aside';
      book.asideMember = book.queue.shift();
      book.readyUntil = D + PICKUP_DAYS;
    } else {
      book.status = 'shelf';
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const memberId = getField(args, 'memberId');
    const bookId = getField(args, 'bookId');
    const D = beginDated(getField(args, 'date'));
    if (D === null) return fail();
    const member = findMember(memberId);
    const book = findBook(bookId);
    if (!member || !book) return fail();
    if (book.status !== 'loan' || book.loanMember !== memberId) return fail();

    const loan = member.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail();
    if (loan.renewals >= MAX_RENEWALS) return fail();
    if (D > loan.dueDate) return fail();
    if (book.queue.length > 0) return fail();

    loan.dueDate = D + LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDate) };
  }

  function placeHold(args) {
    const memberId = getField(args, 'memberId');
    const bookId = getField(args, 'bookId');
    const D = beginDated(getField(args, 'date'));
    if (D === null) return fail();
    const member = findMember(memberId);
    const book = findBook(bookId);
    if (!member || !book) return fail();
    if (book.status === 'shelf') return fail();
    if (book.status === 'loan' && book.loanMember === memberId) return fail();
    if (member.holds.includes(bookId)) return fail();
    if (member.holds.length >= MAX_HOLDS) return fail();

    book.queue.push(memberId);
    member.holds.push(bookId);
    let position = book.queue.length;
    if (book.status === 'aside') position += 1;
    return { ok: true, position };
  }

  function payFine(args) {
    const memberId = getField(args, 'memberId');
    const amount = getField(args, 'amount');
    const D = beginDated(getField(args, 'date'));
    if (D === null) return fail();
    const member = findMember(memberId);
    if (!member) return fail();
    if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) return fail();
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const memberId = getField(args, 'memberId');
    const D = beginDated(getField(args, 'date'));
    if (D === null) return fail();
    const member = findMember(memberId);
    if (!member) return fail();

    const loans = member.loans.map((l) => ({
      bookId: l.bookId,
      dueDate: formatDate(l.dueDate),
    }));

    const holds = member.holds.map((bookId) => {
      const book = books.get(bookId);
      if (book.status === 'aside' && book.asideMember === memberId) {
        return { bookId, position: 1, readyUntil: formatDate(book.readyUntil) };
      }
      const index = book.queue.indexOf(memberId) + 1;
      const position = index + (book.status === 'aside' ? 1 : 0);
      return { bookId, position, readyUntil: null };
    });

    return { loans, owed: member.owed, holds };
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
