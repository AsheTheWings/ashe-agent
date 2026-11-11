-- Where a turn became a context turn: the item position of its context
-- turn component, and whether the reserve or the context limit started
-- it. Both are null for a turn that never became one.
ALTER TABLE turns ADD COLUMN context_item INTEGER;
ALTER TABLE turns ADD COLUMN context_trigger TEXT CHECK (context_trigger IN ('threshold', 'limit'));
