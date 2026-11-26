-- At-most-once alert sending: one alert_sent row per
-- (call, alert_type, recipient). The app inserts this row before sending the
-- SMS; a unique violation (23505) means the alert was already claimed.
create unique index if not exists call_events_alert_once
  on call_events (call_id, (payload->>'alert_type'), (payload->>'recipient_id'))
  where type = 'alert_sent';
