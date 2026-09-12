alter table decisions drop constraint if exists decisions_verification_check;
alter table decisions add constraint decisions_verification_check
  check (verification in ('phone_match_and_reference', 'browser_session', 'operator_override'));
