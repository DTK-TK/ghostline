-- =============================================================================
-- Ghostline – demo seed
-- Inserts one household (family Sun) with a bcrypt-hashed safe word,
-- two family members read from env vars, and one trusted contact.
--
-- Run with: supabase db seed  (or psql < supabase/seeds/demo.sql)
--
-- Env vars consumed at seed time (set them before running):
--   SEED_MEMBER_1_NAME   SEED_MEMBER_1_PHONE
--   SEED_MEMBER_2_NAME   SEED_MEMBER_2_PHONE
--   SEED_CONTACT_NAME    SEED_CONTACT_PHONE
--
-- If the vars are unset the seed substitutes safe placeholder values so it
-- never inserts a real phone number by accident.
-- =============================================================================

DO $$
DECLARE
  v_household_id  uuid;
  v_safe_word     text  := 'pumpkin';
  v_hash          text;

  -- Read teammates from environment; fall back to placeholders.
  v_member1_name  text  := COALESCE(current_setting('app.seed_member1_name',  true), 'Alex Sun');
  v_member1_phone text  := COALESCE(current_setting('app.seed_member1_phone', true), '+10000000001');
  v_member2_name  text  := COALESCE(current_setting('app.seed_member2_name',  true), 'Jordan Sun');
  v_member2_phone text  := COALESCE(current_setting('app.seed_member2_phone', true), '+10000000002');
  v_contact_name  text  := COALESCE(current_setting('app.seed_contact_name',  true), 'Dr. Rivera');
  v_contact_phone text  := COALESCE(current_setting('app.seed_contact_phone', true), '+10000000003');
BEGIN
  -- Hash the safe word with bcrypt (cost 12).
  v_hash := crypt(v_safe_word, gen_salt('bf', 12));

  -- Insert household.
  INSERT INTO households (family_name, senior_phone, safe_word_hash, time_waster_enabled, is_demo)
  VALUES ('Sun', '+15550000000', v_hash, true, true)
  RETURNING id INTO v_household_id;

  -- Insert family members (both get alerts; member 1 accepts callback transfers).
  INSERT INTO family_members (household_id, name, phone, gets_alerts, is_callback_target)
  VALUES
    (v_household_id, v_member1_name, v_member1_phone, true, true),
    (v_household_id, v_member2_name, v_member2_phone, true, false);

  -- Insert a trusted contact that rings straight through.
  INSERT INTO contacts (household_id, name, phone, relationship)
  VALUES (v_household_id, v_contact_name, v_contact_phone, 'doctor');

  RAISE NOTICE 'Demo household "Sun" created with id %', v_household_id;
END;
$$;
