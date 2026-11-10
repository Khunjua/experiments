# Library — what the owner actually wants

The hidden reference for scoring. Models never see this file.
Each line: rule · important or indifferent · how the raw text covers it (stated / vague / no).

- D1 A loan lasts 21 days: dueDate = borrow date + 21. · important · stated
- D2 A member can have at most 5 books on loan; a 6th borrow is refused. · important · no
- D3 A member who owes 1000 cents or more cannot borrow. · important · no
- D4 A book on loan cannot be borrowed by anyone else. · important · no (common sense)
- D5 The late fine is 25 cents per day after the due date; returning on the due date is free. · important · stated
- D6 Returning 1 or 2 days late is free; from 3 days late every late day is charged (3 days = 75). · important · vague ("we don't want to be harsh")
- D7 The fine for one book is capped at 500 cents. · important · vague ("we don't want to be harsh")
- D8 Returning a book the member does not have is refused and charges nothing. · important · no (common sense)
- D9 A renewal moves the due date 21 days forward from the current due date, not from the renewal day. · important · no
- D10 A loan can be renewed at most 2 times; the 3rd renewal is refused. · important · vague ("a couple of times")
- D11 A loan cannot be renewed while anyone has a hold on that book. · important · stated
- D12 An overdue loan cannot be renewed; renewing on the due date is fine. · important · no
- D13 A hold can be placed on a book that is on loan or set aside for someone; a hold on a book free on the shelf is refused. · important · vague ("a hold on a book that's out")
- D14 A member cannot hold a book they have on loan, and cannot hold the same book twice. · important · no
- D15 Holds form a first-come, first-served line; position 1 is next. · important · no (common sense)
- D16 When a book with holds comes back, it is set aside for position 1 until the return date + 3 days (readyUntil, inclusive). Until then only that member can borrow it. · important · no
- D17 If that member has not borrowed it by readyUntil, their hold is dropped and the book is set aside for the next member until the old readyUntil + 3. With nobody left in line, the book is free for anyone. · important · no
- D18 When a member borrows the book set aside for them, their hold ends and everyone behind moves up one place. · important · no
- D19 Fines add up in owed. Payments may be partial; paying more than owed, or 0 or less, is refused. · important · vague ("keep track of who owes us what")
- D20 The order of loans in getMember does not matter. · indifferent · no
