const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 1000;
const BLOCK_OWED = 500;
const PICKUP_DAYS = 7;

function isObj(a) {
  return a !== null && typeof a === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isAmount(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Howard Hinnant's days-from-civil algorithm: day number with 1970-01-01 = 0.
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return { y, m, d };
}

function parseDay(v) {
  if (typeof v !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1 || m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function fmtDay(z) {
  const { y, m, d } = civilFromDays(z);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, readyUntil, queue: [{ memberId, seq }] }
  const members = new Map(); // memberId -> { loans: Map(bookId -> loan), owed }
  let current = null;        // library clock as day number
  let seqCounter = 0;

  const fail = (reason) => ({ ok: false, reason });
  const nextSeq = () => ++seqCounter;

  // Hold expiry (§7.4), repeated until no further change.
  function expire() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const book of books.values()) {
        if (book.readyUntil !== null && current > book.readyUntil) {
          book.queue.shift();
          book.readyUntil = book.queue.length === 0 ? null : book.readyUntil + PICKUP_DAYS + 1;
          changed = true;
        }
      }
    }
  }

  // Clock step (§3.4). Returns false if the date is earlier than the clock.
  function advance(day) {
    if (current !== null && day < current) return false;
    current = day;
    expire();
    return true;
  }

  const wrap = (fn) => (arg) => {
    try {
      return fn(arg);
    } catch {
      return fail('internal error');
    }
  };

  return {
    addBook: wrap((arg) => {
      if (!isObj(arg)) return fail('invalid argument');
      const bookId = arg.bookId;
      if (!isId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, readyUntil: null, queue: [] });
      return { ok: true };
    }),

    addMember: wrap((arg) => {
      if (!isObj(arg)) return fail('invalid argument');
      const memberId = arg.memberId;
      if (!isId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { loans: new Map(), owed: 0 });
      return { ok: true };
    }),

    borrow: wrap((arg) => {
      if (!isObj(arg)) return fail('invalid argument');
      const memberId = arg.memberId;
      const bookId = arg.bookId;
      const day = parseDay(arg.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return fail('invalid input');
      if (!advance(day)) return fail('date earlier than library clock');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (book.loan !== null) return fail('book on loan');
      if (book.readyUntil !== null && book.queue[0].memberId !== memberId) {
        return fail('set aside for another member');
      }
      if (member.loans.size >= MAX_LOANS) return fail('loan limit reached');
      if (member.owed >= BLOCK_OWED) return fail('owed too high');

      if (book.readyUntil !== null) {
        book.queue.shift(); // consume this member's own set-aside hold
      }
      book.readyUntil = null;
      const loan = { bookId, memberId, dueDay: day + LOAN_DAYS, renewals: 0, seq: nextSeq() };
      book.loan = loan;
      member.loans.set(bookId, loan);
      return { ok: true, dueDate: fmtDay(loan.dueDay) };
    }),

    renew: wrap((arg) => {
      if (!isObj(arg)) return fail('invalid argument');
      const memberId = arg.memberId;
      const bookId = arg.bookId;
      const day = parseDay(arg.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return fail('invalid input');
      if (!advance(day)) return fail('date earlier than library clock');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      const loan = book.loan;
      if (loan === null || loan.memberId !== memberId) return fail('not on loan to member');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.queue.length > 0) return fail('book has holds');
      if (day > loan.dueDay) return fail('loan overdue');
      const newDue = day + LOAN_DAYS;
      if (newDue <= loan.dueDay) return fail('renewal does not extend loan');
      loan.dueDay = newDue;
      loan.renewals += 1;
      return { ok: true, dueDate: fmtDay(newDue) };
    }),

    returnBook: wrap((arg) => {
      if (!isObj(arg)) return fail('invalid argument');
      const memberId = arg.memberId;
      const bookId = arg.bookId;
      const day = parseDay(arg.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return fail('invalid input');
      if (!advance(day)) return fail('date earlier than library clock');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      const loan = book.loan;
      if (loan === null || loan.memberId !== memberId) return fail('not on loan to member');

      const daysLate = day - loan.dueDay;
      const chargeable = Math.max(0, daysLate - GRACE_DAYS);
      const fine = Math.min(FINE_PER_DAY * chargeable, MAX_FINE);

      book.loan = null;
      member.loans.delete(bookId);
      member.owed += fine;
      if (book.queue.length > 0) {
        book.readyUntil = day + PICKUP_DAYS;
      } else {
        book.readyUntil = null;
      }
      return { ok: true, fine };
    }),

    placeHold: wrap((arg) => {
      if (!isObj(arg)) return fail('invalid argument');
      const memberId = arg.memberId;
      const bookId = arg.bookId;
      const day = parseDay(arg.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return fail('invalid input');
      if (!advance(day)) return fail('date earlier than library clock');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (book.loan === null && book.readyUntil === null) return fail('book is available');
      if (book.loan !== null && book.loan.memberId === memberId) return fail('member has this book');
      if (book.queue.some((h) => h.memberId === memberId)) return fail('hold already exists');
      book.queue.push({ memberId, seq: nextSeq() });
      return { ok: true, position: book.queue.length };
    }),

    payFine: wrap((arg) => {
      if (!isObj(arg)) return fail('invalid argument');
      const memberId = arg.memberId;
      const amount = arg.amount;
      const day = parseDay(arg.date);
      if (!isId(memberId) || !isAmount(amount) || day === null) return fail('invalid input');
      if (!advance(day)) return fail('date earlier than library clock');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    }),

    getMember: wrap((arg) => {
      if (!isObj(arg)) return fail('invalid argument');
      const memberId = arg.memberId;
      const day = parseDay(arg.date);
      if (!isId(memberId) || day === null) return fail('invalid input');
      if (!advance(day)) return fail('date earlier than library clock');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');

      const loans = [...member.loans.values()]
        .sort((a, b) => a.seq - b.seq)
        .map((l) => ({ bookId: l.bookId, dueDate: fmtDay(l.dueDay) }));

      const found = [];
      for (const [bookId, book] of books) {
        book.queue.forEach((h, i) => {
          if (h.memberId === memberId) {
            found.push({
              seq: h.seq,
              bookId,
              position: i + 1,
              readyUntil: i === 0 && book.readyUntil !== null ? fmtDay(book.readyUntil) : null,
            });
          }
        });
      }
      found.sort((a, b) => a.seq - b.seq);
      const holds = found.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));

      return { ok: true, loans, owed: member.owed, holds };
    }),
  };
}
