insert into public.warehouse_inventory(product_id,on_hand)
select p.id, case p.sku
  when 'PKG-1042' then 18
  when 'PKG-2110' then 7
  when 'SUP-3008' then 24
  when 'PKG-1009' then 0
  when 'PAN-4012' then 31
  when 'SUP-2024' then 14
  else 0
end
from public.products p
on conflict(product_id) do nothing;
