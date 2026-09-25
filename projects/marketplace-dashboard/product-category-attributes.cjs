'use strict';

/*
 attributes(product) returns the explicitly supported facets below. Every value is
 {id, name, evidence}; an unresolved, absent, negated, or conflicting value is null.
 Only product names/articles and named characteristics are evidence. IDs are stable
 lowercase ASCII strings (maximum 40 characters).
*/

const FACETS=['color','material','coating','size','density','pack'];
const empty=()=>Object.fromEntries(FACETS.map(name=>[name,null]));
const clean=value=>typeof value==='string'||typeof value==='number'?String(value).normalize('NFC').trim().replace(/_/gu,' ').replace(/\s+/gu,' '):'';
const normalized=value=>clean(value).toLocaleLowerCase('ru-RU').replace(/ё/gu,'е').replace(/[–—]/gu,'-');
const slug=value=>normalized(value).replace(/,/gu,'.').replace(/[^a-z0-9]+/gu,'-').replace(/^-+|-+$/gu,'').slice(0,40).replace(/-+$/u,'');
const hit=(text,source)=>({id:source.id,name:source.name,evidence:text.evidence});
const term=(id,name,pattern)=>({id,name,pattern});

const COLORS=[
 term('black','чёрный',/(?:^|[^a-zа-я0-9])(?:черн(?:ый|ая|ое|ые|ого|ому|ым|ую|ых|о(?=-))|black)(?=$|[^a-zа-я0-9])/u),
 term('yellow','жёлтый',/(?:^|[^a-zа-я0-9])(?:желт(?:ый|ая|ое|ые|ого|ому|ым|ую|ых|о(?=-))|yellow)(?=$|[^a-zа-я0-9])/u),
 term('white','белый',/(?:^|[^a-zа-я0-9])(?:бел(?:ый|ая|ое|ые|ого|ому|ым|ую|ых|о(?=-))|white)(?=$|[^a-zа-я0-9])/u),
 term('red','красный',/(?:^|[^a-zа-я0-9])(?:красн(?:ый|ая|ое|ые|ого|ому|ым|ую|ых|о(?=-))|red)(?=$|[^a-zа-я0-9])/u),
 term('blue','синий',/(?:^|[^a-zа-я0-9])(?:син(?:ий|яя|ее|ие|его|ему|им|юю|их|е(?=-))|blue)(?=$|[^a-zа-я0-9])/u),
 term('light-blue','голубой',/(?:^|[^a-zа-я0-9])голуб(?:ой|ая|ое|ые|ого|ому|ым|ую|ых)(?=$|[^a-zа-я0-9])/u),
 term('green','зелёный',/(?:^|[^a-zа-я0-9])(?:зелен(?:ый|ая|ое|ые|ого|ому|ым|ую|ых|о(?=-))|green)(?=$|[^a-zа-я0-9])/u),
 term('orange','оранжевый',/(?:^|[^a-zа-я0-9])(?:оранжев(?:ый|ая|ое|ые|ого|ому|ым|ую|ых|о(?=-))|orange)(?=$|[^a-zа-я0-9])/u),
 term('gray','серый',/(?:^|[^a-zа-я0-9])(?:сер(?:ый|ая|ое|ые|ого|ому|ым|ую|ых|о(?=-))|gray|grey)(?=$|[^a-zа-я0-9])/u),
 term('silver','серебристый',/(?:^|[^a-zа-я0-9])(?:серебрист(?:ый|ая|ое|ые|ого|ому|ым|ую|ых)|silver)(?=$|[^a-zа-я0-9])/u),
 term('brown','коричневый',/(?:^|[^a-zа-я0-9])(?:коричнев(?:ый|ая|ое|ые|ого|ому|ым|ую|ых)|brown)(?=$|[^a-zа-я0-9])/u),
 term('beige','бежевый',/(?:^|[^a-zа-я0-9])(?:бежев(?:ый|ая|ое|ые|ого|ому|ым|ую|ых)|beige)(?=$|[^a-zа-я0-9])/u),
 term('transparent','прозрачный',/(?:^|[^a-zа-я0-9])(?:прозрачн(?:ый|ая|ое|ые|ого|ому|ым|ую|ых)|transparent)(?=$|[^a-zа-я0-9])/u)
];
const MATERIALS=[
 term('cotton','хлопок',/(?:^|[^a-zа-я0-9])(?:х\s*[\/-]?\s*б|хлопок|хлопков\p{L}*|хлопчатобумажн\p{L}*)(?=$|[^a-zа-я0-9])/u),
 term('nylon','нейлон',/(?:^|[^a-zа-я0-9])(?:нейлон\p{L}*|полиамид\p{L}*|nylon)(?=$|[^a-zа-я0-9])/u),
 term('nitrile','нитрил',/(?:^|[^a-zа-я0-9])(?:нитрил\p{L}*|nitrile)(?=$|[^a-zа-я0-9])/u),
 term('latex','латекс',/(?:^|[^a-zа-я0-9])(?:латекс\p{L}*|latex)(?=$|[^a-zа-я0-9])/u),
 term('split-leather','спилок',/(?:^|[^a-zа-я0-9])(?:спил(?:ок|ка|ку|ком|ке)|спилков\p{L}*|split leather)(?=$|[^a-zа-я0-9])/u),
 term('leather','кожа',/(?:^|[^a-zа-я0-9])(?:кожа|кожан\p{L}*)(?=$|[^a-zа-я0-9])/u),
 term('pvc','ПВХ',/(?:^|[^a-zа-я0-9])(?:пвх|pvc)(?=$|[^a-zа-я0-9])/u),
 term('stainless-steel','нержавеющая сталь',/(?:нержавеющ\p{L}*\s+стал\p{L}*|нержавейк\p{L}*|stainless steel)/u),
 term('steel','сталь',/(?:^|[^a-zа-я0-9])(?:стал(?:ь|и|ью)|стальн\p{L}*)(?=$|[^a-zа-я0-9])/u),
 term('aluminum','алюминий',/(?:^|[^a-zа-я0-9])(?:алюмини\p{L}*|aluminium|aluminum)(?=$|[^a-zа-я0-9])/u),
 term('polyethylene','полиэтилен',/(?:^|[^a-zа-я0-9])(?:полиэтилен\p{L}*|polyethylene)(?=$|[^a-zа-я0-9])/u),
 term('polyester','полиэстер',/(?:^|[^a-zа-я0-9])(?:полиэстер\p{L}*|polyester)(?=$|[^a-zа-я0-9])/u)
];
const COATINGS=[
 term('yellow-zinc','жёлтый цинк',/(?:желт\p{L}*\s+(?:цинк|оцинков)|(?:цинк|оцинков)\p{L}*\s+желт\p{L}*)/u),
 term('white-zinc','белый цинк',/(?:бел\p{L}*\s+(?:цинк|оцинков)|(?:цинк|оцинков)\p{L}*\s+бел\p{L}*)/u),
 term('black-zinc','чёрный цинк',/(?:черн\p{L}*\s+(?:цинк|оцинков)|(?:цинк|оцинков)\p{L}*\s+черн\p{L}*)/u),
 term('zinc','цинк',/(?:оцинкован\p{L}*|цинков\p{L}*\s+покрыт\p{L}*|покрыт\p{L}*\s+цинк\p{L}*)/u),
 term('phosphate','фосфатированное',/фосфатирован\p{L}*/u),
 term('polymer','полимерное',/полимерн\p{L}*\s+(?:покрыт\p{L}*|напылен\p{L}*)/u),
 term('latex','латекс',/(?:с\s+латекс\p{L}*|латекс\p{L}*\s+(?:покрыт\p{L}*|облив\p{L}*))/u),
 term('nitrile','нитрил',/(?:с\s+нитрил\p{L}*|нитрил\p{L}*\s+(?:покрыт\p{L}*|облив\p{L}*))/u),
 term('pvc','ПВХ',/(?:с\s+(?:пвх|pvc)|(?:пвх|pvc)[ -]*(?:покрыт\p{L}*|напылен\p{L}*|точк\p{L}*))/u)
];

function isNegated(value,index,matched){const offset=matched.search(/[a-zа-я0-9]/u),start=index+(offset<0?0:offset);return /(?:^|[^a-zа-я0-9])(?:не|без)\s*$/u.test(value.slice(Math.max(0,start-12),start))}
function matches(value,terms){
 const found=[];
 for(const item of terms){const flags=item.pattern.flags.includes('g')?item.pattern.flags:item.pattern.flags+'g',pattern=new RegExp(item.pattern.source,flags);for(const match of value.matchAll(pattern))if(!isNegated(value,match.index||0,match[0])){found.push(item);break}}
 return found;
}
function oneOrCombo(text,terms,{multicolor=false}={}){
 if(multicolor&&/(?:многоцветн\p{L}*|разноцветн\p{L}*|ассорти|multicolor)/u.test(text.value))return {id:'multicolor',name:'многоцветный',evidence:text.evidence};
 const found=matches(text.value,terms);if(!found.length)return null;
 if(found.length===1)return hit(text,found[0]);
 const ordered=[...found].sort((a,b)=>a.id.localeCompare(b.id,'en'));
 return {id:ordered.map(item=>item.id).join('-').slice(0,40).replace(/-+$/u,''),name:ordered.map(item=>item.name).join(' + '),evidence:text.evidence};
}
function coating(text,{named=false}={}){
 let found=matches(text.value,COATINGS);
 if(named&&!found.length)found=matches(text.value,[
  term('zinc','цинк',/(?:^|[^a-zа-я0-9])(?:цинк|оцинков\p{L}*)(?=$|[^a-zа-я0-9])/u),
  term('latex','латекс',/(?:^|[^a-zа-я0-9])латекс\p{L}*(?=$|[^a-zа-я0-9])/u),
  term('nitrile','нитрил',/(?:^|[^a-zа-я0-9])нитрил\p{L}*(?=$|[^a-zа-я0-9])/u),
  term('pvc','ПВХ',/(?:^|[^a-zа-я0-9])(?:пвх|pvc)(?=$|[^a-zа-я0-9])/u)
 ]);
 if(!found.length)return null;
 const specific=found.find(item=>item.id.endsWith('-zinc'));return hit(text,specific||found[0]);
}
function material(text,{named=false}={}){
 let found=matches(text.value,MATERIALS);
 if(!named){
  if(/(?:(?:покрыт|облив|напылен|с)\p{L}*\s+(?:из\s+)?нитрил|нитрил\p{L}*\s+(?:покрыт|облив|напылен))/u.test(text.value))found=found.filter(item=>item.id!=='nitrile');
  if(/(?:с\s+латекс|латекс\p{L}*\s+(?:покрыт|облив))/u.test(text.value))found=found.filter(item=>item.id!=='latex');
  if(/(?:с\s+(?:пвх|pvc)|(?:пвх|pvc)[ -]*(?:покрыт|напылен|точк))/u.test(text.value))found=found.filter(item=>item.id!=='pvc');
 }
 if(found.some(item=>item.id==='stainless-steel'))found=found.filter(item=>item.id!=='steel');
 if(!found.length)return null;
 if(found.length>1)return null;
 return hit(text,found[0]);
}
const decimal=value=>String(value).replace(',', '.').replace(/\.0+$/u,'');
const LINEAR_UNIT={мкм:'mkm',мм:'mm',см:'cm',м:'m'},SIZE_PARTS=new WeakMap();
function rememberSize(value,parts){SIZE_PARTS.set(value,parts.map(part=>({value:decimal(part.value),unit:part.unit})));return value}
const linearSize=(parts,evidence)=>{const normalizedParts=parts.map(part=>({value:decimal(part.value),unit:part.unit})),name=normalizedParts.map(part=>part.value+' '+part.unit).join(' × '),id='size-'+normalizedParts.map(part=>part.value+'-'+LINEAR_UNIT[part.unit]).join('x');return rememberSize({id:slug(id),name,evidence},normalizedParts)};
function size(text,{named=false}={}){
 let match=text.value.match(/(?:^|[^0-9])([0-9]+(?:[.,][0-9]+)?)\s*[xх×]\s*([0-9]+(?:[.,][0-9]+)?)(?:\s*[xх×]\s*([0-9]+(?:[.,][0-9]+)?))?\s*(мм|см|м)(?=$|[^а-я])/u);
 if(match){const values=[match[1],match[2],match[3]].filter(Boolean).map(decimal),unit={мм:'mm',см:'cm',м:'m'}[match[4]],name=values.join('×')+' '+match[4];return rememberSize({id:slug('size-'+values.join('x')+'-'+unit),name,evidence:text.evidence},values.map(value=>({value,unit:match[4]})))}
 const axes=new Map();for(const axisMatch of text.value.matchAll(/(ширин\p{L}*|длин\p{L}*|высот\p{L}*|толщин\p{L}*)\s*[:=-]?\s*([0-9]+(?:[.,][0-9]+)?)\s*(мкм|мм|см|м)(?![a-zа-я0-9²³])/gu)){const axis=/^ширин/u.test(axisMatch[1])?'width':/^длин/u.test(axisMatch[1])?'length':/^высот/u.test(axisMatch[1])?'height':'thickness',part={value:axisMatch[2],unit:axisMatch[3]};if(axes.has(axis)&&(decimal(axes.get(axis).value)!==decimal(part.value)||axes.get(axis).unit!==part.unit))return null;axes.set(axis,part)}
 if(axes.size)return linearSize(['width','length','height','thickness'].map(axis=>axes.get(axis)).filter(Boolean),text.evidence);
 match=text.value.match(/(?:^|[^0-9])([0-9]+(?:[.,][0-9]+)?)\s*(мм|см|м)(?![a-zа-я0-9²³])(?:\s*[xх×]\s*|\s+)([0-9]+(?:[.,][0-9]+)?)\s*(мм|см|м)(?![a-zа-я0-9²³])(?:(?:\s*[xх×,]\s*|\s+)([0-9]+(?:[.,][0-9]+)?)\s*(мкм|мм|см|м)(?![a-zа-я0-9²³]))?/u);
 if(match)return linearSize([{value:match[1],unit:match[2]},{value:match[3],unit:match[4]},match[5]&&{value:match[5],unit:match[6]}].filter(Boolean),text.evidence);
 match=text.value.match(/(?:объем\p{L}*\s*)?([0-9]+(?:[.,][0-9]+)?)\s*(л|литр\p{L}*)(?=$|[^а-я])/u);
 if(match){const value=decimal(match[1]);return {id:slug('volume-'+value+'-l'),name:value+' л',evidence:text.evidence}}
 match=text.value.match(/(?:^|[^0-9])([0-9]+(?:[.,][0-9]+)?)\s*(мм|см|м)(?![a-zа-я0-9²³])/u);
 if(match)return linearSize([{value:match[1],unit:match[2]}],text.evidence);
 match=text.value.match(/размер\p{L}*\s*[:=-]?\s*(xxl|xl|[sml]|[0-9]{1,3})(?=$|[^a-zа-я0-9])/u);
 if(!match&&named)match=text.value.match(/^\s*(xxl|xl|[sml]|[0-9]{1,3})\s*$/u);
 if(!match)return null;const value=match[1].toUpperCase();return {id:slug('size-'+value),name:value,evidence:text.evidence};
}
function density(text){const match=text.value.match(/([0-9]+(?:[.,][0-9]+)?)\s*(?:г|гр|g)\s*\/?\s*(?:м2|м²|кв\.?\s*м)/u);if(!match)return null;const value=decimal(match[1]);return {id:slug('density-'+value+'-g-m2'),name:value+' г/м²',evidence:text.evidence}}
function pack(text,{named=false}={}){let match=text.value.match(/([0-9]{1,6})\s*(шт\.?|пар\p{L}*)(?:\s*(?:в\s+упаковке|уп\.?))?/u),unit=match&&/^пар/u.test(match[2])?'pairs':'pieces';if(!match&&named){match=text.value.match(/^\s*([0-9]{1,6})\s*$/u);unit=/пар/u.test(text.characteristicName||'')?'pairs':'pieces'}if(!match)return null;const value=String(Number(match[1]));return {id:slug('pack-'+value+'-'+unit),name:value+(unit==='pairs'?' пар':' шт.'),evidence:text.evidence}}

function characteristicFacet(name){
 if(/цвет|оттенок/u.test(name))return 'color';
 if(/плотност/u.test(name))return 'density';
 if(/покрыт|напылен|облив/u.test(name))return 'coating';
 if(/количеств.*(?:упаков|комплект)|(?:штук|пар).*упаков|фасов/u.test(name))return 'pack';
 if(/размер|габарит|ширин|длин|диаметр|толщин|объем/u.test(name))return 'size';
 if(/материал|состав|основа/u.test(name))return 'material';
 return null;
}
function characteristicSources(product){
 const out=[],dimensions=[];for(const row of Array.isArray(product?.characteristics)?product.characteristics:[]){if(!row||typeof row!=='object')continue;const name=normalized(row.name),facet=characteristicFacet(name);if(!facet)continue;const raw=Array.isArray(row.values)?row.values:[row.value];for(const value of raw){const original=clean(value?.value??value?.name??value);if(!original)continue;const source={facet,value:normalized(original),evidence:'Характеристика «'+clean(row.name)+'»: '+original,named:true,characteristicName:name};const axis=facet==='size'&&(/ширин/u.test(name)?'width':/длин/u.test(name)?'length':/высот/u.test(name)?'height':/толщин/u.test(name)?'thickness':null);if(axis)dimensions.push({...source,axis});else out.push(source)}}
 if(dimensions.length){const axes=new Map();for(const source of dimensions){const match=source.value.match(/^\s*([0-9]+(?:[.,][0-9]+)?)\s*(мкм|мм|см|м)\s*$/u);if(match&&!axes.has(source.axis))axes.set(source.axis,{value:decimal(match[1]),unit:match[2],evidence:source.evidence})}const ordered=['width','length','height','thickness'].map(axis=>axes.get(axis)).filter(Boolean);if(ordered.length){const sameUnit=ordered.every(item=>item.unit===ordered[0].unit),parts=ordered.map(item=>item.value),name=sameUnit?parts.join('×')+' '+ordered[0].unit:ordered.map(item=>item.value+' '+item.unit).join(' × '),units={мкм:'mkm',мм:'mm',см:'cm',м:'m'},id=sameUnit?'size-'+parts.join('x')+'-'+units[ordered[0].unit]:'size-'+ordered.map(item=>item.value+'-'+units[item.unit]).join('x'),evidence=ordered.map(item=>item.evidence).join('; '),direct=rememberSize({id:slug(id),name,evidence},ordered);out.push({facet:'size',value:'',evidence,named:true,direct})}}
 return out;
}
function textSources(product){
 const labels=[['name','Название'],['title','Название'],['product_name','Название'],['offer_id','Артикул'],['vendorCode','Артикул']];const seen=new Set(),out=[];
 for(const [field,label] of labels){const original=clean(product?.[field]);if(!original)continue;const key=label+'\0'+original;if(seen.has(key))continue;seen.add(key);out.push({value:normalized(original),evidence:label+': '+original,named:false})}
 return out;
}
function extract(facet,text){
 if(text.direct)return text.direct;
 if(facet==='color')return oneOrCombo(text,COLORS,{multicolor:true});
 if(facet==='material')return material(text,{named:text.named});
 if(facet==='coating')return coating(text,{named:text.named});
 if(facet==='size')return size(text,{named:text.named});
 if(facet==='density')return density(text);
 if(facet==='pack')return pack(text,{named:text.named});
 return null;
}
function resolve(values){const byId=new Map();for(const value of values)if(value&&!byId.has(value.id))byId.set(value.id,value);return byId.size===1?[...byId.values()][0]:null}
function resolveSize(values){const byId=new Map();for(const value of values)if(value&&!byId.has(value.id))byId.set(value.id,value);if(byId.size<=1)return byId.size?[...byId.values()][0]:null;const candidates=[...byId.values()].sort((a,b)=>(SIZE_PARTS.get(b)?.length||0)-(SIZE_PARTS.get(a)?.length||0)),contains=(whole,part)=>{const available=whole.map(item=>item.value+'\0'+item.unit);for(const item of part){const index=available.indexOf(item.value+'\0'+item.unit);if(index<0)return false;available.splice(index,1)}return true};for(const candidate of candidates){const whole=SIZE_PARTS.get(candidate);if(whole&&candidates.every(other=>{const parts=SIZE_PARTS.get(other);return parts&&contains(whole,parts)}))return candidate}return null}
function attributes(product){
 const result=empty(),named=characteristicSources(product),texts=textSources(product);
 const coatingIds=new Set();for(const source of named)if(source.facet==='coating'){const value=extract('coating',source);if(value)coatingIds.add(value.id)}for(const source of texts){const value=extract('coating',source);if(value)coatingIds.add(value.id)}
 for(const facet of FACETS){const candidates=[];for(const source of named)if(source.facet===facet)candidates.push(extract(facet,source));for(const source of texts){const value=extract(facet,source),coveredMaterial=facet==='material'&&value&&['latex','nitrile','pvc'].includes(value.id)&&coatingIds.has(value.id);candidates.push(coveredMaterial?null:value)}result[facet]=facet==='size'?resolveSize(candidates):resolve(candidates)}
 return result;
}

module.exports={attributes};
