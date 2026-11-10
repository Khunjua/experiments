const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const HOLD_WINDOW = 7;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Howard Hinnant's proleptic Gregorian day-count algorithms (pure integer math, no time zone).
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

const MAX_DAY = daysFromCivil(9999, 12, 31);

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const n = daysFromCivil(y, m, d);
  const back = civilFromDays(n);
  if (back.y !== y || back.m !== m || back.d !== d) return null;
  return n;
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function formatDay(n) {
  const { y, m, d } = civilFromDays(n);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function validAmount(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

function readArg(arg, keys) {
  if (typeof arg !== 'object' || arg === null) return null;
  const out = {};
  for (const k of keys) out[k] = arg[k];
  return out;
}

function fail(reason) {
  return { ok: false, reason };
}

function guard(fn) {
  try {
    return fn();
  } catch {
    return fail('INVALID_INPUT');
  }
}

export function createLibrary() {
  // bookId -> { id, status: 'available' | 'on_loan' | 'set_aside', loan, holds }
  // loan: { memberId, dueDay, renewals, seq } or null
  // holds: ordered [{ memberId, seq, readyUntil }]; readyUntil is a day number or null
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();
  let clock = null;
  let seqCounter = 0;

  function freeBook(book, day) {
    book.loan = null;
    if (book.holds.length === 0) {
      book.status = 'available';
      return;
    }
    book.status = 'set_aside';
    book.holds[0].readyUntil = Math.min(day + HOLD_WINDOW, MAX_DAY);
  }

  function catchUp(upTo) {
    for (const book of books.values()) {
      // A set-aside hold with readyUntil R expires at the start of R + 1.
      while (book.status === 'set_aside' && book.holds[0].readyUntil < upTo) {
        const expiredDay = book.holds[0].readyUntil + 1;
        book.holds.shift();
        freeBook(book, expiredDay);
      }
    }
  }

  function advance(day) {
    clock = day;
    catchUp(day);
  }

  return {
    addBook(arg) {
      return guard(() => {
        const a = readArg(arg, ['bookId']);
        if (!a || !validId(a.bookId)) return fail('INVALID_INPUT');
        if (books.has(a.bookId)) return fail('DUPLICATE');
        books.set(a.bookId, {
          id: a.bookId,
          status: 'available',
          loan: null,
          holds: [],
        });
        return { ok: true };
      });
    },

    addMember(arg) {
      return guard(() => {
        const a = readArg(arg, ['memberId']);
        if (!a || !validId(a.memberId)) return fail('INVALID_INPUT');
        if (members.has(a.memberId)) return fail('DUPLICATE');
        members.set(a.memberId, { owed: 0 });
        return { ok: true };
      });
    },

    borrow(arg) {
      return guard(() => {
        const a = readArg(arg, ['memberId', 'bookId', 'date']);
        if (!a) return fail('INVALID_INPUT');
        const d = parseDate(a.date);
        if (!validId(a.memberId) || !validId(a.bookId) || d === null) return fail('INVALID_INPUT');
        if (clock !== null && d < clock) return fail('DATE_OUT_OF_ORDER');
        advance(d);

        const member = members.get(a.memberId);
        if (!member) return fail('NO_MEMBER');
        const book = books.get(a.bookId);
        if (!book) return fail('NO_BOOK');
        if (book.status === 'on_loan') return fail('NOT_AVAILABLE');
        if (book.status === 'set_aside' && book.holds[0].memberId !== a.memberId) {
          return fail('NOT_AVAILABLE');
        }
        const due = d + LOAN_DAYS;
        if (due > MAX_DAY) return fail('OUT_OF_RANGE');

        if (book.status === 'set_aside') book.holds.shift();
        book.status = 'on_loan';
        book.loan = { memberId: a.memberId, dueDay: due, renewals: 0, seq: ++seqCounter };
        return { ok: true, dueDate: formatDay(due) };
      });
    },

    returnBook(arg) {
      return guard(() => {
        const a = readArg(arg, ['memberId', 'bookId', 'date']);
        if (!a) return fail('INVALID_INPUT');
        const d = parseDate(a.date);
        if (!validId(a.memberId) || !validId(a.bookId) || d === null) return fail('INVALID_INPUT');
        if (clock !== null && d < clock) return fail('DATE_OUT_OF_ORDER');
        advance(d);

        const member = members.get(a.memberId);
        if (!member) return fail('NO_MEMBER');
        const book = books.get(a.bookId);
        if (!book) return fail('NO_BOOK');
        if (book.status !== 'on_loan' || book.loan.memberId !== a.memberId) {
          return fail('NOT_ON_LOAN');
        }

        const late = Math.max(0, d - book.loan.dueDay);
        const fine = Math.min(FINE_PER_DAY * late, FINE_CAP);
        member.owed += fine;
        freeBook(book, d);
        return { ok: true, fine };
      });
    },

    renew(arg) {
      return guard(() => {
        const a = readArg(arg, ['memberId', 'bookId', 'date']);
        if (!a) return fail('INVALID_INPUT');
        const d = parseDate(a.date);
        if (!validId(a.memberId) || !validId(a.bookId) || d === null) return fail('INVALID_INPUT');
        if (clock !== null && d < clock) return fail('DATE_OUT_OF_ORDER');
        advance(d);

        const member = members.get(a.memberId);
        if (!member) return fail('NO_MEMBER');
        const book = books.get(a.bookId);
        if (!book) return fail('NO_BOOK');
        if (book.status !== 'on_loan' || book.loan.memberId !== a.memberId) {
          return fail('NOT_ON_LOAN');
        }
        const loan = book.loan;
        if (d > loan.dueDay) return fail('OVERDUE');
        if (loan.renewals >= MAX_RENEWALS) return fail('RENEWAL_LIMIT');
        if (book.holds.length > 0) return fail('HAS_HOLDS');
        const due = d + LOAN_DAYS;
        if (due > MAX_DAY) return fail('OUT_OF_RANGE');

        loan.dueDay = due;
        loan.renewals += 1;
        return { ok: true, dueDate: formatDay(due) };
      });
    },

    placeHold(arg) {
      return guard(() => {
        const a = readArg(arg, ['memberId', 'bookId', 'date']);
        if (!a) return fail('INVALID_INPUT');
        const d = parseDate(a.date);
        if (!validId(a.memberId) || !validId(a.bookId) || d === null) return fail('INVALID_INPUT');
        if (clock !== null && d < clock) return fail('DATE_OUT_OF_ORDER');
        advance(d);

        const member = members.get(a.memberId);
        if (!member) return fail('NO_MEMBER');
        const book = books.get(a.bookId);
        if (!book) return fail('NO_BOOK');
        if (book.status === 'available') return fail('BOOK_AVAILABLE');
        if (book.status === 'on_loan' && book.loan.memberId === a.memberId) {
          return fail('ALREADY_BORROWED');
        }
        if (book.holds.some((h) => h.memberId === a.memberId)) {
          return fail('ALREADY_HOLDING');
        }

        book.holds.push({ memberId: a.memberId, seq: ++seqCounter, readyUntil: null });
        return { ok: true, position: book.holds.length };
      });
    },

    payFine(arg) {
      return guard(() => {
        const a = readArg(arg, ['memberId', 'amount', 'date']);
        if (!a) return fail('INVALID_INPUT');
        const d = parseDate(a.date);
        if (!validId(a.memberId) || !validAmount(a.amount) || d === null) {
          return fail('INVALID_INPUT');
        }
        if (clock !== null && d < clock) return fail('DATE_OUT_OF_ORDER');
        advance(d);

        const member = members.get(a.memberId);
        if (!member) return fail('NO_MEMBER');
        if (a.amount > member.owed) return fail('BAD_AMOUNT');

        member.owed -= a.amount;
        return { ok: true, owed: member.owed };
      });
    },

    getMember(arg) {
      return guard(() => {
        const a = readArg(arg, ['memberId', 'date']);
        if (!a) return fail('INVALID_INPUT');
        const d = parseDate(a.date);
        if (!validId(a.memberId) || d === null) return fail('INVALID_INPUT');
        if (clock !== null && d < clock) return fail('DATE_OUT_OF_ORDER');
        advance(d);

        const member = members.get(a.memberId);
        if (!member) return fail('NO_MEMBER');

        const loanRows = [];
        const holdRows = [];
        for (const book of books.values()) {
          if (book.status === 'on_loan' && book.loan.memberId === a.memberId) {
            loanRows.push({ seq: book.loan.seq, bookId: book.id, dueDay: book.loan.dueDay });
          }
          book.holds.forEach((h, i) => {
            if (h.memberId === a.memberId) {
              holdRows.push({
                seq: h.seq,
                bookId: book.id,
                position: i + 1,
                readyDay: h.readyUntil,
              });
            }
          });
        }
        loanRows.sort((x, y) => x.seq - y.seq);
        holdRows.sort((x, y) => x.seq - y.seq);

        return {
          loans: loanRows.map((l) => ({ bookId: l.bookId, dueDate: formatDay(l.dueDay) })),
          owed: member.owed,
          holds: holdRows.map((h) => ({
            bookId: h.bookId,
            position: h.position,
            readyUntil: h.readyDay === null ? null : formatDay(h.readyDay),
          })),
        };
      });
    },
  };
}
