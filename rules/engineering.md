# Engineering Rules

1. Business transitions live in deterministic core code first.
2. API contracts use strict schemas shared across services.
3. Every request carries `request_id`, `trace_id`, `case_id` when known, and no sensitive baggage.
4. Demos may use deterministic fixtures, but fixture names must make simulation obvious.
5. Prefer small vertical slices with runnable verification over broad untested surfaces.
