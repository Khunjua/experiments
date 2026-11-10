Community library: loans, renewals, holds and fines.

Loans
1. A loan lasts 21 days: the due date is the borrow date + 21 days.
2. A member can have at most 5 books on loan at once. Borrowing a 6th book is refused.
3. A member who owes 1000 cents or more cannot borrow.
4. A book that is on loan cannot be borrowed by anyone else.

Returns and fines
5. A late return costs 25 cents for each day after the due date. Returning on or before the due date is free.
6. Returning 1 or 2 days late is free. From 3 days late, every late day is charged, so 3 days late costs 75 cents.
7. The fine for one returned book is capped at 500 cents.
8. Returning a book the member does not have on loan is refused and charges nothing.

Renewals
9. A renewal moves the due date 21 days forward from the current due date, not from the day of the renewal.
10. A loan can be renewed at most 2 times. A 3rd renewal is refused.
11. A loan cannot be renewed while anyone has a hold on that book.
12. An overdue loan cannot be renewed. Renewing on the due date itself is allowed.

Holds
13. A hold can be placed on a book that is on loan or set aside for someone. A hold on a book that is free on the shelf is refused.
14. A member cannot place a hold on a book they have on loan, and cannot hold the same book twice.
15. Holds form a first-come, first-served line. Position 1 is next.
16. When a book with holds is returned, it is set aside for the member in position 1 until the return date + 3 days (readyUntil, inclusive). Until then only that member can borrow it.
17. If that member has not borrowed the book by readyUntil, their hold is dropped and the book is set aside for the next member in line until the old readyUntil + 3 days. When nobody is left in line, the book is free for anyone.
18. When a member borrows the book set aside for them, their hold ends and everyone behind them moves up one place.

Money
19. Fines add up in the amount owed. A payment may be partial. Paying more than is owed, or paying 0 or less, is refused.
20. The order of loans returned by getMember does not matter.
