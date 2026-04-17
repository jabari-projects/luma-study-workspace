-- Run this after applying subscription_schema.sql and profile_role_schema.sql.
update public.profiles
set username = 'midnight_admin',
    subscription_status = 'premium',
    role = 'admin'
where user_id = '37e1da7d-5d64-456d-bcbf-126cf62ca5e0';
