-- Only changes the business contact, never customer phone numbers.
begin;
update public.business_settings
set whatsapp_number = '+5493564526723', updated_at = now()
where id = 'main';
commit;
select business_name, whatsapp_number from public.business_settings where id = 'main';
