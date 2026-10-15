type Row=Record<string,unknown>;
export function projectStoreOrder(order:Row):Row {
  const fields=['id','clientRequestId','portalReference','orderNumber','organization','locationLicense','locationName',
    'submittedByRole','state','publicState','ownerApprovalRequired','orderValueCents','containsPreorder','releaseHold',
    'deliveryWindow','receivingContact','receivingInstructions','submittedAt','acceptedAt','updatedAt'];
  const result:Row={};for(const field of fields)result[field]=order[field];
  result.lines=(Array.isArray(order.lines)?order.lines:[]).map(line=>{
    const safe:Row={};for(const field of ['id','lineNumber','productId','productName','sku','quantity','unit','unitPriceCents','lineTotalCents','orderMode','releaseState'])safe[field]=line[field];return safe;
  });
  result.events=(Array.isArray(order.events)?order.events:[]).map(e=>({id:e.id,fromState:e.fromState,toState:e.toState,createdAt:e.createdAt}));
  return result;
}
