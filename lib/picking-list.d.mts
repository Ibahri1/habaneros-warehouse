export type PickingListOrder={order_number:string;items:Array<{product_id:string|null;name:string;sku:string|null;unit_size:string|null;item_location:string|null;requested_quantity:number}>};
export type PickingListProduct={id:string;category:string|null;item_location:string|null};
export type ConsolidatedPickingItem={key:string;name:string;sku:string|null;category:string|null;item_location:string|null;unit_size:string|null;quantity:number;orders:string[]};
export function consolidatePickingItems(orders:PickingListOrder[],products:PickingListProduct[]):ConsolidatedPickingItem[];
