'use strict';

const FAMILY_CATEGORY = Object.freeze({
  'anchor-adjustable': 'Анкер (домкрат) регулировочный',
  'anchor-bolt-nut': 'Анкерный болт с гайкой',
  'anchor-wedge': 'Анкер-клин',
  'angle-135': 'Уголок под 135 градусов',
  'angle-anchor': 'Уголок крепежный анкерный',
  'angle-asymmetric': 'Уголок крепежный ассиметричный',
  'angle-equal': 'Уголок крепежный равносторонний',
  'angle-general': 'Уголки крепежные',
  'angle-reinforced': 'Уголок крепежный усиленный',
  'bag-construction': 'Мешки для мусора',
  'beam-holder': 'Держатель балки',
  'beam-support-closed': 'Опора бруса',
  'beam-support-open': 'Опора бруса',
  'bracket-t': 'Кронштейн Т-образный',
  'caulk-gun': 'Пистолеты для герметиков',
  'concrete-screw': 'Нагель по бетону',
  'confirmat': 'Винт конфирмат (еврошуруп)',
  'construction-stilts': 'Строительные подмости, козлы, ходули',
  'construction-trestles': 'Строительные подмости, козлы, ходули',
  'disc-metal': 'Диски по металлу',
  'dowel-aerated-concrete': 'Металлический дюбель для газобетона',
  'dowel-insulation': 'Дюбеля для теплоизоляции',
  'dowel-nail': 'Дюбель-гвозди',
  'film-bubble': 'Воздушно-пузырчатая пленка',
  'film-cover-polyethylene': 'Пленка укрывная',
  'film-protective-tape': 'Пленка защитная',
  'film-stretch': 'Стрейч-пленка',
  'floor-screw': 'Шурупы для полов и паркета',
  'glue-construction': 'Строительная химия',
  'hanger-straight': 'Прямой подвес',
  'label-thermal': 'Термоэтикетки',
  'lag-screw': 'Шуруп сантехнический (глухарь)',
  'mesh-basalt-masonry': 'Сетка базальтовая',
  'mesh-metal-welded': 'Сетка',
  'mesh-rodent-cpvs': 'Сетка ЦПВС',
  'mesh-rodent-welded': 'Сетка',
  'mesh-serpyanka': 'Сетка фасадная, малярная',
  'mesh-shade-facade': 'Сетка для укрытия строительных лесов',
  'mounting-tape-greenhouse': 'Лента тарная',
  'mounting-tape-straight': 'Перфорированная монтажная лента',
  'mounting-tape-wave': 'Перфорированная монтажная лента',
  'paint-fiberglass': 'Стеклохолст',
  'pipe-wrench': 'Ручной инструмент',
  'pipe-clip': 'Крепёж-клипса для труб для монтажного пистолета',
  'plate-connecting': 'Пластины соединительные',
  'plate-nail': 'Пластины гвоздевые',
  'plate-unspecified': 'Пластины крепежные',
  'post-fastener-drive': 'Крепеж для стоек в землю',
  'post-base': 'Основание колонны',
  'rafter-support-sliding': 'Опора скользящая для стропил',
  'rivet-blind': 'Заклепки',
  'rivet-threaded': 'Заклепки',
  'screw-gvl': 'Саморез по ГВЛ',
  'snow-shovel': 'Лопаты',
  'scoop-shovel': 'Лопаты',
  'bayonet-shovel': 'Лопаты',
  'tape-aluminum': 'Алюминиевый скотч',
  'tape-double-sided': 'Скотч',
  'tape-general': 'Скотч',
  'tape-masking': 'Скотч',
  'tape-mounting-adhesive': 'Скотч',
  'tape-packing-clear': 'Скотч',
  'tarpaulin-density-120': 'Тент плотностью 120 г/м2',
  'tarpaulin-density-230': 'Тент плотностью 230 г/м2',
  'tarpaulin-density-70': 'Тент плотностью 70 г/м2',
  'tarpaulin-density-90': 'Тент плотностью 90 г/м2',
  'tarpaulin-universal': 'Тент укрывной',
  'tile-leveling-tool': 'Система выравнивания плитки (СВП)',
  'traverse-mounting': 'Траверса монтажная',
  'wallpaper': 'Обои под покраску флизелиновые',
  'welding-electrode': 'Электроды'
});

function clean(value) {
  return value == null ? '' : String(value).normalize('NFC').toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е').replace(/[–—]/gu, '-').replace(/_/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function productText(product) {
  const values = [product?.name, product?.title, product?.product_name, product?.offer_id, product?.vendorCode];
  for (const row of Array.isArray(product?.characteristics) ? product.characteristics : []) {
    if (!row || typeof row !== 'object') continue;
    values.push(row.name);
    for (const value of Array.isArray(row.values) ? row.values : [row.value]) values.push(value?.value ?? value?.name ?? value);
  }
  return clean(values.filter(value => value != null).join(' '));
}

function facetId(facets, name) {
  const value = facets?.[name];
  return clean(value && typeof value === 'object' ? value.id ?? value.name : value);
}

function has(text, pattern) { return pattern.test(text); }
function explicitFacet(facets, name) {
  return Object.prototype.hasOwnProperty.call(facets || {}, name);
}
function coated(text, facets, name) {
  if (explicitFacet(facets, 'coating')) {
    const id = facetId(facets, 'coating');
    return name === 'zinc' ? id === 'zinc' || id.endsWith('-zinc') : id === name;
  }
  return name === 'zinc' && has(text, /(?:цинк|оцинкован\p{L}*)/u);
}
function color(text, facets, name) {
  if (explicitFacet(facets, 'color')) return facetId(facets, 'color') === name;
  const id = facetId(facets, 'color');
  if (id) return id === name;
  const evidence = text.replace(/(?:^|\W)(?:не|без)\s+(?:черн\p{L}*|желт\p{L}*|black|yellow)(?=$|\W)/gu, ' ');
  const found = [];
  if (has(evidence, /(?:^|\W)(?:черн\p{L}*|black)(?:$|\W)/u)) found.push('black');
  if (has(evidence, /(?:^|\W)(?:желт\p{L}*|yellow)(?:$|\W)/u)) found.push('yellow');
  return found.length === 1 && found[0] === name;
}

function selectCategory(familyId, product = {}, facets = {}) {
  const family = clean(familyId);
  if (!family) return null;
  const text = productText(product);

  // A narrow explicit product name may correct a stale reviewed family.
  if (has(text, /(?:малярн\p{L}*\s+(?:лент|скотч)|скотч\s+малярн\p{L}*)/u)) return 'Скотч';
  if (has(text, /(?:упаковочн\p{L}*\s+(?:лент|скотч)|скотч\s+упаковочн\p{L}*)/u)) return 'Скотч';
  if (has(text, /(?:алюминиев\p{L}*\s+(?:лент|скотч)|скотч\s+алюминиев\p{L}*)/u)) return 'Алюминиевый скотч';

  if (family === 'screw-wood') {
    if (color(text, facets, 'black')) return 'Саморезы черные по дереву';
    if (color(text, facets, 'yellow')) return 'Саморезы желтые по дереву';
    if (coated(text, facets, 'zinc')) return 'Саморезы оцинкованные по дереву';
    return 'Саморезы';
  }
  if (family === 'screw-metal') return color(text, facets, 'black') ? 'Саморезы черные по металлу' : 'Саморезы';
  if (family === 'screw-universal') return has(text, /(?:^|\W)(?:pz|pozi|pozy)(?:$|\W)/u) ? 'Саморез универсальный (Pz)' : 'Саморезы';
  if (family === 'screw-unspecified') return 'Саморезы';
  if (family === 'screw-roof-metal' || family === 'screw-roof-wood') {
    if (has(text, /(?:крашен\p{L}*|\bral\s*\d{3,4}\b)/u)) return 'Саморезы для кровли крашенные';
    if (coated(text, facets, 'zinc') && has(text, /увеличенн\p{L}*\s+сверл/u)) return 'Саморезы для кровли оцинкованные с увеличенным сверлом';
    if (coated(text, facets, 'zinc')) return 'Саморезы для кровли оцинкованные';
    return 'Саморезы для кровли';
  }
  if (family === 'screw-metal-press') {
    if (has(text, /(?:со\s+сверл\p{L}*|сверл\p{L}*\s+наконечник)/u)) return 'Саморезы с прессшайбой со сверлом';
    if (has(text, /(?:остр\p{L}*|без\s+сверл\p{L}*)/u)) return 'Саморезы с прессшайбой острые';
    return 'Саморезы';
  }
  if (family === 'screw-structural') return has(text, /(?:^|\W)torx(?:$|\W)/u) ? 'Саморез конструкционный Torx' : 'Саморезы';
  if (family === 'nail-construction') {
    if (coated(text, facets, 'zinc')) return 'Гвозди строительные оцинкованные';
    if (color(text, facets, 'black')) return 'Гвозди строительные черные';
    return 'Гвозди';
  }
  if (family === 'nail-unspecified') return 'Гвозди';
  if (family === 'nail-tool') {
    if (has(text, /(?:^|\W)d\s*34(?:$|\W)/u)) return 'Реечные гвозди по дереву на бумажной кассете D34';
    if (has(text, /16\s*ga/u)) return 'Отделочные гвозди по дереву 16Ga';
    return null;
  }
  if (family === 'nut-hex' || family === 'oldnut-hex') {
    if (has(text, /(?:^|\W)din\s*985(?:$|\W)/u)) return 'Гайка с нейлоновой вставкой DIN 985';
    if (has(text, /(?:^|\W)din\s*934(?:$|\W)/u) && coated(text, facets, 'zinc')) return 'Гайка оцинкованная DIN 934';
    return 'Гайки';
  }
  if (family === 'nut-connecting') return has(text, /(?:^|\W)din\s*6334(?:$|\W)/u) ? 'Гайка соединительная DIN 6334' : 'Гайки';
  if (family === 'nail-ring') return coated(text, facets, 'zinc') ? 'Гвозди ершеные оцинкованные' : 'Гвозди';
  if (family === 'nail-screw') return coated(text, facets, 'zinc') ? 'Гвозди винтовые оцинкованные' : 'Гвозди';
  if (family === 'nail-roofing') return coated(text, facets, 'zinc') ? 'Гвозди кровельные оцинкованные' : 'Гвозди';
  if (family === 'anchor-driven') return has(text, /латун\p{L}*/u) ? 'Анкер латунный' : 'Забивной анкер "Цанга"';
  if (family === 'bolt-standard') {
    if (!has(text, /(?:^|\W)din\s*933(?:$|\W)/u)) return 'Болты';
    if (has(text, /(?:а2|a2|нержаве\p{L}*)/u)) return 'Болт с полной резьбой din 933 А2 нержавеющий';
    if (coated(text, facets, 'zinc')) return 'Болт с полной резьбой din 933 оцинкованный';
    return 'Болты';
  }
  if (family === 'angle-general') {
    if (has(text, /(?:^|\W)z[ -]?образн\p{L}*(?:$|\W)/u)) return 'Уголок крепежный Z-образный';
    if (coated(text, facets, 'zinc')) return 'Уголок крепежный оцинкованный';
    return 'Уголки крепежные';
  }
  if (family === 'profile-pipe-plug') {
    if (has(text, /квадратн\p{L}*/u)) return 'Заглушки квадратные пластиковые';
    if (has(text, /прямоугольн\p{L}*/u)) return 'Заглушки прямоугольные пластиковые';
    if (has(text, /кругл\p{L}*/u)) return 'Заглушки круглые пластиковые';
    return 'Заглушки пластиковые для труб';
  }
  if (family === 'mesh-fiberglass-facade' || family === 'mesh-fiberglass-paint' || family === 'mesh-fiberglass-plaster') return 'Сетка фасадная, малярная';
  if (family === 'mesh-rodent-unspecified') return 'Сетка';
  if (family === 'mesh-metal-cpvs') return 'Сетка ЦПВС';
  if (family === 'mesh-metal-welded' || family === 'mesh-rodent-welded') return coated(text, facets, 'zinc') && has(text, /рулон\p{L}*/u) ? 'Сетка сварная оцинкованная в рулонах' : 'Сетка';
  if (/^gloves-/u.test(family) || family === 'signal-vest') return family === 'signal-vest' ? 'Спецодежда' : 'Защита рук';
  if (family === 'tarpaulin-density-85' || family === 'tarpaulin-density-180' || family === 'tarpaulin-density-220') return 'Тент укрывной';
  if (family === 'tape-packing-clear') return 'Скотч';
  if (family === 'bolt-nut-cap') return color(text, facets, 'black') ? 'Колпачок пластиковый на болт/гайку (черный)' : 'Крепеж и метизы';
  if (family === 'machine-screw') return has(text, /(?:^|\W)din\s*7985(?:$|\W)/u) ? 'Винт с полусферой DIN 7985' : 'Винты';
  if (family === 'washer-flat') return has(text, /(?:^|\W)din\s*125(?:$|\W)/u) ? 'Шайба плоская din 125' : 'Шайбы';
  if (family === 'washer-lock') return has(text, /(?:^|\W)din\s*127(?:$|\W)/u) ? 'Шайба (гровер) DIN 127' : 'Шайбы';
  if (family === 'washer-large') {
    if (has(text, /нержаве\p{L}*/u)) return 'Шайба увеличенная нержавеющая';
    return has(text, /(?:^|\W)din\s*9021(?:$|\W)/u) ? 'Шайба усиленная DIN 9021' : 'Шайбы';
  }
  if (family === 'stud-threaded') return has(text, /(?:^|\W)din\s*975(?:$|\W)/u) ? 'Шпилька резьбовая DIN 975' : 'Крепеж и метизы';
  if (family === 'turnbuckle-hook-ring') return has(text, /(?:^|\W)din\s*1480(?:$|\W)/u) ? 'Талреп крюк-кольцо DIN 1480' : 'Талрепы';
  if (family === 'steel-rope-coated') return has(text, /(?:^|\W)din\s*3055(?:$|\W)/u) ? 'Трос стальной в ПВХ оплетке, DIN 3055' : 'Такелаж';
  if (family === 'staple-construction') return has(text, /гладк\p{L}*/u) ? 'Строительная скоба гладкая' : 'Крепеж и метизы';
  if (family === 'circular-saw' || family === 'collated-screwdriver' || family === 'power-screwdriver' || family === 'rotary-hammer') {
    return has(text, /аккумуляторн\p{L}*|(?:^|\W)акб(?:$|\W)/u) ? 'Аккумуляторный инструмент' : 'Электроинструменты';
  }
  if (family === 'pneumatic-nailer') {
    if (has(text, /аккумуляторн\p{L}*|без\s+газа/u)) return 'Аккумуляторный инструмент';
    return has(text, /газов\p{L}*/u) ? 'Газовые гвоздезабивные и монтажные пистолеты' : 'Электроинструменты';
  }
  if (family === 'tool-battery') return has(text, /(?:^|\W)toua(?:$|\W)/u) ? 'Аккумуляторы для инструментов Toua' : null;
  if (family === 'mounting-gun-barrel') return has(text, /(?:^|\W)toua(?:$|\W)/u) ? 'Сменные стволы и насадки на ствол Toua' : null;

  return FAMILY_CATEGORY[family] || null;
}

module.exports = { selectCategory };
