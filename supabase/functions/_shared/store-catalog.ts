type Row=Record<string,unknown>;
const row=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const text=(value:unknown)=>typeof value==='string'?value:null;
const results=(value:unknown)=>Array.isArray(value)?value.map(v=>{const r=row(v);return{name:text(r.name),value:typeof r.value==='number'||typeof r.value==='string'?r.value:null,unit:text(r.unit)};}):[];
/** Positive allowlist: package identity/custody and commercial fields must not
 * survive into education-only views, even when the source grows new columns. */
export function projectStoreProducts(products:Row[],educationOnly:boolean):Row[] {
  return products.filter(p=>!educationOnly || (p.releaseVerified===true&&p.orderMode==='standard')).map(p=>{
    const content=row(p.content), market=row(p.marketplace), constraints=row(p.orderConstraints);
    const safe:Row={id:p.id,sourceId:p.sourceId,name:p.name,brand:p.brand,category:p.category,subCategory:p.subCategory,
      format:p.format,sku:p.sku,strain:p.strain,releaseVerified:p.releaseVerified,
      content:{shortDescription:text(content.shortDescription),longDescription:text(content.longDescription),
        sellingPoints:Array.isArray(content.sellingPoints)?content.sellingPoints.filter(v=>typeof v==='string'):[],
        ingredients:text(content.ingredients),usageInformation:text(content.usageInformation),productProfile:text(content.productProfile),
        imageUrl:text(content.imageUrl),keywords:Array.isArray(content.keywords)?content.keywords.filter(v=>typeof v==='string'):[]},
      lots:(Array.isArray(p.lots)?p.lots:[]).map(v=>{const lot=row(v),coa=row(lot.coa);return {
        lab:text(lot.lab),hasCoa:lot.hasCoa===true,releaseVerified:lot.releaseVerified===true,
        coa:{documentUrl:text(coa.documentUrl),labName:text(coa.labName),testedAt:text(coa.testedAt),
          cannabinoids:results(coa.cannabinoids),terpenes:results(coa.terpenes)},
      };}),
    };
    if(!educationOnly) Object.assign(safe,{orderMode:p.orderMode,releaseLabel:p.releaseLabel,mixedRelease:p.mixedRelease,
      orderConstraints:{caseQuantity:constraints.caseQuantity,caseQuantityUnit:constraints.caseQuantityUnit,
        caseEnforcementAvailable:constraints.caseEnforcementAvailable,minimumOrder:constraints.minimumOrder,leadTimeDays:constraints.leadTimeDays},
      marketplace:{marketplaceProductId:market.marketplaceProductId,unitPriceCents:market.unitPriceCents,saleUnit:market.saleUnit,
        minimumOrderQuantity:market.minimumOrderQuantity,syncedAt:market.syncedAt},
      // Exact quantity is withheld until reservation/commitment coverage is
      // verified; a missing number is never presented as zero stock.
      availableUnits:null});
    return safe;
  });
}
