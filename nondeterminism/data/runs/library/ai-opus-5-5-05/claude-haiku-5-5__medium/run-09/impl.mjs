const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FEE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 1000;
const BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const REQUEUE_GAP = 8;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

// Howard Hinnant's civil-date algorithms, pure integer arithmetic (no Date, no time zones).
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
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

// Returns a day number for a valid 'YYYY-MM-DD' string, otherwise null.
function toDay(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function fmt(z) {
  const [y, m, d] = civilFromDays(z);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isObj(v) {
  return v !== null && typeof v === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isAmount(v) {
  return Number.isSafeInteger(v) && v > 0;
}

export function createLibrary() {
  // book: { loan: null | { memberId, dueDay, renewals }, queue: [{ memberId, seq }], readyDay: number | null }
  // member: { loans: [bookId, ...] in creation order, owed: number }
  const books = new Map();
  const members = new Map();
  let today = null;
  let nextSeq = 0;

  const fail = (reason) => ({ ok: false, reason });

  // Hold expiry (§7.4). Applies to every book that is set aside.
  function expire() {
    for (const book of books.values()) {
      if (book.loan !== null) continue;
      while (
        book.queue.length > 0 &&
        book.readyDay !== null &&
        today > book.readyDay
      ) {
        book.queue.shift();
        if (book.queue.length === 0) {
          book.readyDay = null;
        } else {
          book.readyDay = book.readyDay + REQUEUE_GAP;
        }
      }
    }
  }

  // Clock step (§3.4). Returns false if the date is earlier than the clock.
  function advance(day) {
    if (today !== null && day < today) return false;
    today = day;
    expire();
    return true;
  }

  return {
    addBook(arg) {
      try {
        if (!isObj(arg)) return fail('invalid argument');
        const bookId = arg.bookId;
        if (!isId(bookId)) return fail('invalid book id');
        if (books.has(bookId)) return fail('book exists');
        books.set(bookId, { loan: null, queue: [], readyDay: null });
        return { ok: true };
      } catch {
        return fail('internal error');
      }
    },

    addMember(arg) {
      try {
        if (!isObj(arg)) return fail('invalid argument');
        const memberId = arg.memberId;
        if (!isId(memberId)) return fail('invalid member id');
        if (members.has(memberId)) return fail('member exists');
        members.set(memberId, { loans: [], owed: 0 });
        return { ok: true };
      } catch {
        return fail('internal error');
      }
    },

    borrow(arg) {
      try {
        if (!isObj(arg)) return fail('invalid argument');
        const memberId = arg.memberId;
        const bookId = arg.bookId;
        if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
        const day = toDay(arg.date);
        if (day === null) return fail('invalid date');
        if (!advance(day)) return fail('date before clock');

        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail('unknown member or book');
        if (book.loan !== null) return fail('on loan');
        if (book.queue.length > 0 && book.queue[0].memberId !== memberId) {
          return fail('set aside for another member');
        }
        if (member.loans.length >= MAX_LOANS) return fail('loan limit reached');
        if (member.owed >= BLOCK_OWED) return fail('owed too much');

        if (book.queue.length > 0) book.queue.shift();
        const dueDay = day + LOAN_DAYS;
        book.loan = { memberId, dueDay, renewals: 0 };
        book.readyDay = null;
        member.loans.push(bookId);
        return { ok: true, dueDate: fmt(dueDay) };
      } catch {
        return fail('internal error');
      }
    },

    renew(arg) {
      try {
        if (!isObj(arg)) return fail('invalid argument');
        const memberId = arg.memberId;
        const bookId = arg.bookId;
        if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
        const day = toDay(arg.date);
        if (day === null) return fail('invalid date');
        if (!advance(day)) return fail('date before clock');

        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail('unknown member or book');
        const loan = book.loan;
        if (loan === null || loan.memberId !== memberId) return fail('not on loan to member');
        if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
        if (book.queue.length > 0) return fail('book is wanted');
        if (day > loan.dueDay) return fail('overdue');
        const newDue = day + LOAN_DAYS;
        if (newDue <= loan.dueDay) return fail('renewal does not extend loan');

        loan.dueDay = newDue;
        loan.renewals += 1;
        return { ok: true, dueDate: fmt(newDue) };
      } catch {
        return fail('internal error');
      }
    },

    returnBook(arg) {
      try {
        if (!isObj(arg)) return fail('invalid argument');
        const memberId = arg.memberId;
        const bookId = arg.bookId;
        if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
        const day = toDay(arg.date);
        if (day === null) return fail('invalid date');
        if (!advance(day)) return fail('date before clock');

        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail('unknown member or book');
        const loan = book.loan;
        if (loan === null || loan.memberId !== memberId) return fail('not on loan to member');

        const daysLate = day - loan.dueDay;
        const chargeable = Math.max(0, daysLate - GRACE_DAYS);
        const fine = Math.min(FEE_PER_DAY * chargeable, MAX_FINE);

        member.owed += fine;
        member.loans = member.loans.filter((id) => id !== bookId);
        book.loan = null;
        if (book.queue.length === 0) {
          book.readyDay = null;
        } else {
          book.readyDay = day + PICKUP_DAYS;
        }
        return { ok: true, fine };
      } catch {
        return fail('internal error');
      }
    },

    placeHold(arg) {
      try {
        if (!isObj(arg)) return fail('invalid argument');
        const memberId = arg.memberId;
        const bookId = arg.bookId;
        if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
        const day = toDay(arg.date);
        if (day === null) return fail('invalid date');
        if (!advance(day)) return fail('date before clock');

        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail('unknown member or book');
        if (book.loan === null && book.queue.length === 0) return fail('book is available');
        if (book.loan !== null && book.loan.memberId === memberId) return fail('member has the loan');
        if (book.queue.some((e) => e.memberId === memberId)) return fail('already holding');

        book.queue.push({ memberId, seq: nextSeq++ });
        return { ok: true, position: book.queue.length };
      } catch {
        return fail('internal error');
      }
    },

    payFine(arg) {
      try {
        if (!isObj(arg)) return fail('invalid argument');
        const memberId = arg.memberId;
        if (!isId(memberId)) return fail('invalid member id');
        const amount = arg.amount;
        if (!isAmount(amount)) return fail('invalid amount');
        const day = toDay(arg.date);
        if (day === null) return fail('invalid date');
        if (!advance(day)) return fail('date before clock');

        const member = members.get(memberId);
        if (!member) return fail('unknown member');
        if (amount > member.owed) return fail('overpayment');

        member.owed -= amount;
        return { ok: true, owed: member.owed };
      } catch {
        return fail('internal error');
      }
    },

    getMember(arg) {
      try {
        if (!isObj(arg)) return fail('invalid argument');
        const memberId = arg.memberId;
        if (!isId(memberId)) return fail('invalid member id');
        const day = toDay(arg.date);
        if (day === null) return fail('invalid date');
        if (!advance(day)) return fail('date before clock');

        const member = members.get(memberId);
        if (!member) return fail('unknown member');

        const loans = member.loans.map((bookId) => ({
          bookId,
          dueDate: fmt(books.get(bookId).loan.dueDay),
        }));

        const found = [];
        for (const [bookId, book] of books) {
          const idx = book.queue.findIndex((e) => e.memberId === memberId);
          if (idx < 0) continue;
          const setAside = idx === 0 && book.loan === null && book.readyDay !== null;
          found.push({
            seq: book.queue[idx].seq,
            hold: {
              bookId,
              position: idx + 1,
              readyUntil: setAside ? fmt(book.readyDay) : null,
            },
          });
        }
        found.sort((a, b) => a.seq - b.seq);
        const holds = found.map((f) => f.hold);

        return { ok: true, loans, owed: member.owed, holds };
      } catch {
        return fail('internal error');
      }
    },
  };
}
