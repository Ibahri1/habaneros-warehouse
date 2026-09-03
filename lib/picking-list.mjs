export function consolidatePickingItems(orders,products){
  const productById=new Map(products.map(product=>[product.id,product]));
  const grouped=new Map();
  for(const order of orders){
    for(const item of order.items){
      const product=item.product_id?productById.get(item.product_id):undefined;
      const key=item.product_id||`${item.sku||""}|${item.name}|${item.unit_size||""}`;
      const existing=grouped.get(key);
      if(existing){
        existing.quantity+=item.requested_quantity;
        if(!existing.orders.includes(order.order_number))existing.orders.push(order.order_number);
      }else{
        grouped.set(key,{key,name:item.name,sku:item.sku,category:product?.category||null,item_location:item.item_location||product?.item_location||null,unit_size:item.unit_size,quantity:item.requested_quantity,orders:[order.order_number]});
      }
    }
  }
  return [...grouped.values()].sort((a,b)=>(a.item_location||"~").localeCompare(b.item_location||"~")||a.name.localeCompare(b.name));
}
