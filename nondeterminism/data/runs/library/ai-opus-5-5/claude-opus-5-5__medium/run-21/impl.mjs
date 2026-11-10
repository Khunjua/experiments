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

// Pure integer proleptic Gregorian arithmetic (equivalent to UTC day counts, no time zones).
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

function field(args, key) {
  if (args === null || (typeof args !== 'object' && typeof args !== 'function')) return undefined;
  return args[key];
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // book: { loan: {memberId, dueDate, renewals} | null, queue: [hold], readyUntil: number|null }
  const books = new Map();
  // member: { owed, loans: [bookId], holds: [hold] }
  const members = new Map();
  let current = null;

  function removeHoldFromMember(hold) {
    const m = members.get(hold.memberId);
    const i = m.holds.indexOf(hold);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function expire(day) {
    for (const book of books.values()) {
      while (book.loan === null && book.queue.length > 0 && day > book.readyUntil) {
        const prev = book.readyUntil;
        const hold = book.queue.shift();
        removeHoldFromMember(hold);
        if (book.queue.length > 0) {
          book.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns day number or null if the date is invalid / earlier than current.
  function begin(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    expire(day);
    return day;
  }

  function isSetAside(book) {
    return book.loan === null && book.queue.length > 0;
  }

  function safe(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return fail('error');
      }
    };
  }

  return {
    addBook: safe((args) => {
      const bookId = field(args, 'bookId');
      if (!isId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('duplicate book');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    }),

    addMember: safe((args) => {
      const memberId = field(args, 'memberId');
      if (!isId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('duplicate member');
      members.set(memberId, { owed: 0, loans: [], holds: [] });
      return { ok: true };
    }),

    borrow: safe((args) => {
      const memberId = field(args, 'memberId');
      const bookId = field(args, 'bookId');
      const day = begin(field(args, 'date'));
      if (day === null) return fail('invalid date');
      if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('not registered');
      if (book.loan !== null) return fail('on loan');
      const setAsideForMe = isSetAside(book) && book.queue[0].memberId === memberId;
      if (isSetAside(book) && !setAsideForMe) return fail('set aside for another member');
      if (member.loans.length >= MAX_LOANS) return fail('too many loans');
      for (const bid of member.loans) {
        if (books.get(bid).loan.dueDate < day) return fail('overdue loan');
      }
      if (member.owed >= OWED_BLOCK) return fail('owes too much');

      if (setAsideForMe) {
        const hold = book.queue.shift();
        removeHoldFromMember(hold);
        book.readyUntil = null;
      }
      const dueDate = day + LOAN_DAYS;
      book.loan = { memberId, dueDate, renewals: 0 };
      member.loans.push(bookId);
      return { ok: true, dueDate: formatDate(dueDate) };
    }),

    returnBook: safe((args) => {
      const memberId = field(args, 'memberId');
      const bookId = field(args, 'bookId');
      const day = begin(field(args, 'date'));
      if (day === null) return fail('invalid date');
      if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('not registered');
      if (book.loan === null || book.loan.memberId !== memberId) return fail('not on loan to member');

      const daysLate = Math.max(0, day - book.loan.dueDate);
      const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
      member.owed += fine;
      const i = member.loans.indexOf(bookId);
      if (i >= 0) member.loans.splice(i, 1);
      book.loan = null;
      book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
      return { ok: true, fine };
    }),

    renew: safe((args) => {
      const memberId = field(args, 'memberId');
      const bookId = field(args, 'bookId');
      const day = begin(field(args, 'date'));
      if (day === null) return fail('invalid date');
      if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('not registered');
      if (book.loan === null || book.loan.memberId !== memberId) return fail('not on loan to member');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (day > book.loan.dueDate) return fail('overdue');
      if (book.queue.length > 0) return fail('holds waiting');
      book.loan.dueDate = day + RENEW_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: formatDate(book.loan.dueDate) };
    }),

    placeHold: safe((args) => {
      const memberId = field(args, 'memberId');
      const bookId = field(args, 'bookId');
      const day = begin(field(args, 'date'));
      if (day === null) return fail('invalid date');
      if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('not registered');
      if (book.loan === null && book.queue.length === 0) return fail('book available');
      if (book.loan !== null && book.loan.memberId === memberId) return fail('member has book');
      if (book.queue.some((h) => h.memberId === memberId)) return fail('already holding');
      if (member.holds.length >= MAX_HOLDS) return fail('too many holds');
      const hold = { memberId, bookId };
      book.queue.push(hold);
      member.holds.push(hold);
      return { ok: true, position: book.queue.length };
    }),

    payFine: safe((args) => {
      const memberId = field(args, 'memberId');
      const amount = field(args, 'amount');
      const day = begin(field(args, 'date'));
      if (day === null) return fail('invalid date');
      if (!isId(memberId)) return fail('invalid id');
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail('invalid amount');
      const member = members.get(memberId);
      if (!member) return fail('not registered');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    }),

    getMember: safe((args) => {
      const memberId = field(args, 'memberId');
      const day = begin(field(args, 'date'));
      if (day === null) return fail('invalid date');
      if (!isId(memberId)) return fail('invalid id');
      const member = members.get(memberId);
      if (!member) return fail('not registered');
      const loans = member.loans.map((bid) => ({
        bookId: bid,
        dueDate: formatDate(books.get(bid).loan.dueDate),
      }));
      const holds = member.holds.map((h) => {
        const book = books.get(h.bookId);
        const idx = book.queue.indexOf(h);
        const ready = book.loan === null && idx === 0;
        return {
          bookId: h.bookId,
          position: idx + 1,
          readyUntil: ready ? formatDate(book.readyUntil) : null,
        };
      });
      return { ok: true, loans, owed: member.owed, holds };
    }),
  };
}
