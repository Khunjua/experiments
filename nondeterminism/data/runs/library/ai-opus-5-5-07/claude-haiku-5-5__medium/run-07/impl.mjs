const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const BLOCK_THRESHOLD = 500;
const PICKUP_DAYS = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Calendar arithmetic on epoch days (proleptic Gregorian, no time zones).
function floorDiv(a, b) {
  return Math.floor(a / b);
}

function daysFromCivil(y, m, d) {
  if (m <= 2) y -= 1;
  const era = floorDiv(y, 400);
  const yoe = y - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = floorDiv(153 * mp + 2, 5) + d - 1;
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = floorDiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = floorDiv(
    doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096),
    365
  );
  let y = yoe + era * 400;
  const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100));
  const mp = floorDiv(5 * doy + 2, 153);
  const d = doy - floorDiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  return { y, m, d };
}

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

function formatDate(n) {
  const { y, m, d } = civilFromDays(n);
  return (
    String(y).padStart(4, '0') + '-' +
    String(m).padStart(2, '0') + '-' +
    String(d).padStart(2, '0')
  );
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function asObj(x) {
  return x !== null && typeof x === 'object' ? x : {};
}

function attempt(fn) {
  try {
    return fn();
  } catch {
    return { ok: false };
  }
}

export function createLibrary() {
  const books = new Map();
  // book: { status: 'available'|'loan'|'aside', holder, dueDate, renewals, readyUntil, line }
  const members = new Map();
  // member: { owed, loans: Set<bookId>, holds: Set<bookId> }

  // Expiry processing (§5.4) for day D (epoch-day number).
  function expire(day) {
    for (const book of books.values()) {
      if (book.status !== 'aside') continue;
      while (book.status === 'aside' && day > book.readyUntil) {
        const removed = book.line.shift();
        members.get(removed).holds.delete(removedBookId(book));
        if (book.line.length > 0) {
          book.holder = book.line[0];
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.status = 'available';
          book.holder = null;
          book.readyUntil = null;
        }
      }
    }
  }

  // Each book record remembers its own id so expiry can update member holds.
  function removedBookId(book) {
    return book.id;
  }

  // Common steps 1–2 for dated methods. Returns the day number, or null if the date is invalid.
  function prepare(o) {
    const day = parseDate(o.date);
    if (day === null) return null;
    expire(day);
    return day;
  }

  return {
    addBook(args) {
      return attempt(() => {
        const o = asObj(args);
        const bookId = o.bookId;
        if (!isId(bookId) || books.has(bookId)) return { ok: false };
        books.set(bookId, {
          id: bookId,
          status: 'available',
          holder: null,
          dueDate: null,
          renewals: 0,
          readyUntil: null,
          line: [],
        });
        return { ok: true };
      });
    },

    addMember(args) {
      return attempt(() => {
        const o = asObj(args);
        const memberId = o.memberId;
        if (!isId(memberId) || members.has(memberId)) return { ok: false };
        members.set(memberId, { owed: 0, loans: new Set(), holds: new Set() });
        return { ok: true };
      });
    },

    borrow(args) {
      return attempt(() => {
        const o = asObj(args);
        const day = prepare(o);
        if (day === null) return { ok: false };
        const memberId = o.memberId;
        const bookId = o.bookId;
        if (!isId(memberId) || !isId(bookId)) return { ok: false };
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return { ok: false };
        if (book.status === 'loan') return { ok: false };
        if (book.status === 'aside' && book.holder !== memberId) return { ok: false };
        for (const id of member.loans) {
          if (books.get(id).dueDate < day) return { ok: false };
        }
        if (member.owed >= BLOCK_THRESHOLD) return { ok: false };

        if (book.status === 'aside') {
          // The reserved member is at position 1; remove that hold, others shift up.
          book.line.shift();
          member.holds.delete(bookId);
        }
        book.status = 'loan';
        book.holder = memberId;
        book.dueDate = day + LOAN_DAYS;
        book.renewals = 0;
        book.readyUntil = null;
        member.loans.add(bookId);
        return { ok: true, dueDate: formatDate(book.dueDate) };
      });
    },

    returnBook(args) {
      return attempt(() => {
        const o = asObj(args);
        const day = prepare(o);
        if (day === null) return { ok: false };
        const memberId = o.memberId;
        const bookId = o.bookId;
        if (!isId(memberId) || !isId(bookId)) return { ok: false };
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return { ok: false };
        if (book.status !== 'loan' || book.holder !== memberId) return { ok: false };

        const late = day - book.dueDate;
        const chargeable = Math.max(0, late - GRACE_DAYS);
        const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
        member.owed += fine;
        member.loans.delete(bookId);

        book.dueDate = null;
        book.renewals = 0;
        if (book.line.length > 0) {
          book.status = 'aside';
          book.holder = book.line[0];
          book.readyUntil = day + PICKUP_DAYS;
        } else {
          book.status = 'available';
          book.holder = null;
          book.readyUntil = null;
        }
        return { ok: true, fine };
      });
    },

    renew(args) {
      return attempt(() => {
        const o = asObj(args);
        const day = prepare(o);
        if (day === null) return { ok: false };
        const memberId = o.memberId;
        const bookId = o.bookId;
        if (!isId(memberId) || !isId(bookId)) return { ok: false };
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return { ok: false };
        if (book.status !== 'loan' || book.holder !== memberId) return { ok: false };
        if (day > book.dueDate) return { ok: false };
        if (book.renewals >= MAX_RENEWALS) return { ok: false };
        if (book.line.length > 0) return { ok: false };
        if (member.owed >= BLOCK_THRESHOLD) return { ok: false };

        book.dueDate = day + LOAN_DAYS;
        book.renewals += 1;
        return { ok: true, dueDate: formatDate(book.dueDate) };
      });
    },

    placeHold(args) {
      return attempt(() => {
        const o = asObj(args);
        const day = prepare(o);
        if (day === null) return { ok: false };
        const memberId = o.memberId;
        const bookId = o.bookId;
        if (!isId(memberId) || !isId(bookId)) return { ok: false };
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return { ok: false };
        if (book.status === 'available') return { ok: false };
        if (book.status === 'loan' && book.holder === memberId) return { ok: false };
        if (book.line.includes(memberId)) return { ok: false };

        book.line.push(memberId);
        member.holds.add(bookId);
        return { ok: true, position: book.line.length };
      });
    },

    payFine(args) {
      return attempt(() => {
        const o = asObj(args);
        const day = prepare(o);
        if (day === null) return { ok: false };
        const memberId = o.memberId;
        const amount = o.amount;
        if (!isId(memberId)) return { ok: false };
        if (!Number.isInteger(amount) || amount <= 0) return { ok: false };
        const member = members.get(memberId);
        if (!member) return { ok: false };
        if (amount > member.owed) return { ok: false };

        member.owed -= amount;
        return { ok: true, owed: member.owed };
      });
    },

    getMember(args) {
      return attempt(() => {
        const o = asObj(args);
        const day = prepare(o);
        if (day === null) return { ok: false };
        const memberId = o.memberId;
        if (!isId(memberId)) return { ok: false };
        const member = members.get(memberId);
        if (!member) return { ok: false };

        const loans = [];
        for (const bookId of member.loans) {
          const book = books.get(bookId);
          loans.push({ bookId, dueDate: formatDate(book.dueDate) });
        }

        const holds = [];
        for (const bookId of member.holds) {
          const book = books.get(bookId);
          const asideForMember = book.status === 'aside' && book.holder === memberId;
          holds.push({
            bookId,
            position: book.line.indexOf(memberId) + 1,
            readyUntil: asideForMember ? formatDate(book.readyUntil) : null,
          });
        }

        return { loans, owed: member.owed, holds };
      });
    },
  };
}
