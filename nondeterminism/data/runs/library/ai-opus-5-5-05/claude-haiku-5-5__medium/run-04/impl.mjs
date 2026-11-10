const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 1000;
const BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const NEXT_WINDOW_STEP = 8; // PICKUP_DAYS + 1: next window starts the day after the previous one ended

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Proleptic Gregorian day numbers (days since 1970-01-01), pure integer arithmetic.
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z0) {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
}

const MIN_DAY = daysFromCivil(1, 1, 1);
const MAX_DAY = daysFromCivil(9999, 12, 31);

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function formatDate(day) {
  const [y, m, d] = civilFromDays(day);
  return pad(y, 4) + '-' + pad(m, 2) + '-' + pad(d, 2);
}

// Returns null if the result would fall outside 0001-01-01 .. 9999-12-31.
function addDays(day, n) {
  const r = day + n;
  if (r < MIN_DAY || r > MAX_DAY) return null;
  return r;
}

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function fail(reason) {
  return { ok: false, reason };
}

function safe(fn) {
  return (arg) => {
    try {
      return fn(arg);
    } catch {
      return fail('internal error');
    }
  };
}

export function createLibrary() {
  const books = new Map();   // bookId -> book
  const members = new Map(); // memberId -> member
  let clock = null;          // current day number, or null if unset

  // Advances the clock and processes hold expiry. Returns false if day is earlier than the clock.
  function advance(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    for (const book of books.values()) {
      while (
        book.loan === null &&
        book.queue.length > 0 &&
        book.readyUntil !== null &&
        clock > book.readyUntil
      ) {
        const expired = book.queue.shift();
        members.get(expired).holds.delete(book.id);
        if (book.queue.length === 0) {
          book.readyUntil = null;
        } else {
          book.readyUntil = Math.min(book.readyUntil + NEXT_WINDOW_STEP, MAX_DAY);
        }
      }
    }
    return true;
  }

  function readArg(arg, keys) {
    if (!isObj(arg)) return null;
    return keys.map((k) => arg[k]);
  }

  const api = {
    addBook: safe((arg) => {
      if (!isObj(arg)) return fail('bad argument');
      const { bookId } = arg;
      if (!validId(bookId)) return fail('bad id');
      if (books.has(bookId)) return fail('exists');
      books.set(bookId, { id: bookId, loan: null, queue: [], readyUntil: null });
      return { ok: true };
    }),

    addMember: safe((arg) => {
      if (!isObj(arg)) return fail('bad argument');
      const { memberId } = arg;
      if (!validId(memberId)) return fail('bad id');
      if (members.has(memberId)) return fail('exists');
      members.set(memberId, { owed: 0, loans: new Map(), holds: new Map() });
      return { ok: true };
    }),

    borrow: safe((arg) => {
      if (!isObj(arg)) return fail('bad argument');
      const { memberId, bookId, date } = arg;
      if (!validId(memberId) || !validId(bookId)) return fail('bad id');
      const day = parseDate(date);
      if (day === null) return fail('bad date');
      if (!advance(day)) return fail('date before clock');

      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (book.loan !== null) return fail('on loan');
      if (book.queue.length > 0 && book.queue[0] !== memberId) return fail('set aside for another member');
      if (member.loans.size >= MAX_LOANS) return fail('loan limit reached');
      if (member.owed >= BLOCK_OWED) return fail('owed too much');
      const due = addDays(day, LOAN_DAYS);
      if (due === null) return fail('date out of range');

      book.loan = { memberId, dueDay: due, renewals: 0 };
      member.loans.set(bookId, true);
      if (book.queue.length > 0) {
        // Book was set aside for this member: consume that hold.
        book.queue.shift();
        member.holds.delete(bookId);
        book.readyUntil = null;
      }
      return { ok: true, dueDate: formatDate(due) };
    }),

    renew: safe((arg) => {
      if (!isObj(arg)) return fail('bad argument');
      const { memberId, bookId, date } = arg;
      if (!validId(memberId) || !validId(bookId)) return fail('bad id');
      const day = parseDate(date);
      if (day === null) return fail('bad date');
      if (!advance(day)) return fail('date before clock');

      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      const loan = book.loan;
      if (loan === null || loan.memberId !== memberId) return fail('not on loan to member');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.queue.length > 0) return fail('someone is waiting');
      if (day > loan.dueDay) return fail('overdue');
      const due = addDays(day, LOAN_DAYS);
      if (due === null || due <= loan.dueDay) return fail('does not extend loan');

      loan.dueDay = due;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(due) };
    }),

    returnBook: safe((arg) => {
      if (!isObj(arg)) return fail('bad argument');
      const { memberId, bookId, date } = arg;
      if (!validId(memberId) || !validId(bookId)) return fail('bad id');
      const day = parseDate(date);
      if (day === null) return fail('bad date');
      if (!advance(day)) return fail('date before clock');

      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      const loan = book.loan;
      if (loan === null || loan.memberId !== memberId) return fail('not on loan to member');

      const daysLate = day - loan.dueDay;
      const chargeable = Math.max(0, daysLate - GRACE_DAYS);
      const fine = Math.min(FINE_PER_DAY * chargeable, MAX_FINE);

      let readyDay = null;
      if (book.queue.length > 0) {
        readyDay = addDays(day, PICKUP_DAYS);
        if (readyDay === null) return fail('date out of range');
      }

      book.loan = null;
      member.loans.delete(bookId);
      member.owed += fine;
      book.readyUntil = readyDay; // null if queue empty (book becomes available)
      return { ok: true, fine };
    }),

    placeHold: safe((arg) => {
      if (!isObj(arg)) return fail('bad argument');
      const { memberId, bookId, date } = arg;
      if (!validId(memberId) || !validId(bookId)) return fail('bad id');
      const day = parseDate(date);
      if (day === null) return fail('bad date');
      if (!advance(day)) return fail('date before clock');

      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (book.loan === null && book.queue.length === 0) return fail('book is available');
      if (book.loan !== null && book.loan.memberId === memberId) return fail('member has this book');
      if (member.holds.has(bookId)) return fail('already holding');

      book.queue.push(memberId);
      member.holds.set(bookId, true);
      return { ok: true, position: book.queue.length };
    }),

    payFine: safe((arg) => {
      if (!isObj(arg)) return fail('bad argument');
      const { memberId, amount, date } = arg;
      if (!validId(memberId)) return fail('bad id');
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail('bad amount');
      const day = parseDate(date);
      if (day === null) return fail('bad date');
      if (!advance(day)) return fail('date before clock');

      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    }),

    getMember: safe((arg) => {
      if (!isObj(arg)) return fail('bad argument');
      const { memberId, date } = arg;
      if (!validId(memberId)) return fail('bad id');
      const day = parseDate(date);
      if (day === null) return fail('bad date');
      if (!advance(day)) return fail('date before clock');

      const member = members.get(memberId);
      if (!member) return fail('unknown member');

      const loans = [];
      for (const bookId of member.loans.keys()) {
        const book = books.get(bookId);
        loans.push({ bookId, dueDate: formatDate(book.loan.dueDay) });
      }

      const holds = [];
      for (const bookId of member.holds.keys()) {
        const book = books.get(bookId);
        const position = book.queue.indexOf(memberId) + 1;
        const setAsideForMe =
          book.loan === null &&
          book.queue[0] === memberId &&
          book.readyUntil !== null;
        holds.push({
          bookId,
          position,
          readyUntil: setAsideForMe ? formatDate(book.readyUntil) : null,
        });
      }

      return { ok: true, loans, owed: member.owed, holds };
    }),
  };

  return api;
}
