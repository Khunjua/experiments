const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const GRACE_DAYS = 0;
const BORROW_BLOCK_OWED = 1000;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Howard Hinnant's civil-date algorithms (proleptic Gregorian, day 0 = 1970-01-01).
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

// Returns a day number, or null if the string is not a valid YYYY-MM-DD date.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const match = DATE_RE.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const n = daysFromCivil(y, m, d);
  const [cy, cm, cd] = civilFromDays(n);
  if (cy !== y || cm !== m || cd !== d) return null;
  return n;
}

function formatDate(n) {
  const [y, m, d] = civilFromDays(n);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function obj(x) {
  return x !== null && typeof x === 'object' ? x : {};
}

function removeOnce(arr, value) {
  const idx = arr.indexOf(value);
  if (idx >= 0) arr.splice(idx, 1);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let latest = null;

  // Expiry processing up to day D (section 6.4).
  function expire(D) {
    for (const b of books.values()) {
      while (b.status === 'aside' && b.readyUntil < D) {
        const holder = members.get(b.asideMember);
        if (holder) removeOnce(holder.holds, b.bookId);
        const start = b.readyUntil + 1;
        if (b.queue.length > 0) {
          b.asideMember = b.queue.shift();
          b.readyUntil = start + PICKUP_DAYS;
        } else {
          b.status = 'shelf';
          b.asideMember = null;
          b.readyUntil = null;
        }
      }
    }
  }

  // Validates a dated call's date, advances time and runs expiry.
  // Returns the day number, or null if the call must be rejected.
  function accept(date) {
    const d = parseDate(date);
    if (d === null) return null;
    if (latest !== null && d < latest) return null;
    latest = d;
    expire(d);
    return d;
  }

  return {
    addBook(args) {
      const { bookId } = obj(args);
      if (!isId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, {
        bookId,
        status: 'shelf',
        loanMember: null,
        dueDay: null,
        renewals: 0,
        asideMember: null,
        readyUntil: null,
        queue: [],
      });
      return { ok: true };
    },

    addMember(args) {
      const { memberId } = obj(args);
      if (!isId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0, loans: [], holds: [] });
      return { ok: true };
    },

    borrow(args) {
      const { memberId, bookId, date } = obj(args);
      const d = accept(date);
      if (d === null) return { ok: false };
      if (!isId(memberId) || !isId(bookId)) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.status === 'loan') return { ok: false };
      if (b.status === 'aside' && b.asideMember !== memberId) return { ok: false };
      if (b.status === 'shelf' && b.queue.length > 0) return { ok: false };
      if (m.loans.length >= MAX_LOANS) return { ok: false };
      if (m.owed >= BORROW_BLOCK_OWED) return { ok: false };

      if (b.status === 'aside') {
        removeOnce(m.holds, bookId);
        b.asideMember = null;
        b.readyUntil = null;
      }
      b.status = 'loan';
      b.loanMember = memberId;
      b.dueDay = d + LOAN_DAYS;
      b.renewals = 0;
      m.loans.push(bookId);
      return { ok: true, dueDate: formatDate(b.dueDay) };
    },

    returnBook(args) {
      const { memberId, bookId, date } = obj(args);
      const d = accept(date);
      if (d === null) return { ok: false };
      if (!isId(memberId) || !isId(bookId)) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.status !== 'loan' || b.loanMember !== memberId) return { ok: false };

      const daysLate = Math.max(0, d - b.dueDay - GRACE_DAYS);
      const fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      m.owed += fine;
      removeOnce(m.loans, bookId);

      b.loanMember = null;
      b.dueDay = null;
      b.renewals = 0;
      if (b.queue.length > 0) {
        b.status = 'aside';
        b.asideMember = b.queue.shift();
        b.readyUntil = d + PICKUP_DAYS;
      } else {
        b.status = 'shelf';
      }
      return { ok: true, fine };
    },

    renew(args) {
      const { memberId, bookId, date } = obj(args);
      const d = accept(date);
      if (d === null) return { ok: false };
      if (!isId(memberId) || !isId(bookId)) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.status !== 'loan' || b.loanMember !== memberId) return { ok: false };
      if (b.renewals >= MAX_RENEWALS) return { ok: false };
      if (d > b.dueDay) return { ok: false };
      if (b.queue.length > 0) return { ok: false };

      b.dueDay = d + LOAN_DAYS;
      b.renewals += 1;
      return { ok: true, dueDate: formatDate(b.dueDay) };
    },

    placeHold(args) {
      const { memberId, bookId, date } = obj(args);
      const d = accept(date);
      if (d === null) return { ok: false };
      if (!isId(memberId) || !isId(bookId)) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.status === 'shelf') return { ok: false };
      if (b.status === 'loan' && b.loanMember === memberId) return { ok: false };
      if (b.status === 'aside' && b.asideMember === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      if (m.holds.length >= MAX_HOLDS) return { ok: false };

      b.queue.push(memberId);
      m.holds.push(bookId);
      const position = b.queue.length + (b.status === 'aside' ? 1 : 0);
      return { ok: true, position };
    },

    payFine(args) {
      const { memberId, amount, date } = obj(args);
      const d = accept(date);
      if (d === null) return { ok: false };
      if (!isId(memberId)) return { ok: false };
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const { memberId, date } = obj(args);
      const d = accept(date);
      if (d === null) return { ok: false };
      if (!isId(memberId)) return { ok: false };
      const m = members.get(memberId);
      if (!m) return { ok: false };

      const loans = m.loans.map((bookId) => {
        const b = books.get(bookId);
        return { bookId, dueDate: formatDate(b.dueDay) };
      });

      const holds = m.holds.map((bookId) => {
        const b = books.get(bookId);
        if (b.status === 'aside' && b.asideMember === memberId) {
          return { bookId, position: 1, readyUntil: formatDate(b.readyUntil) };
        }
        const idx = b.queue.indexOf(memberId);
        const position = idx + 1 + (b.status === 'aside' ? 1 : 0);
        return { bookId, position, readyUntil: null };
      });

      return { loans, owed: m.owed, holds };
    },
  };
}
