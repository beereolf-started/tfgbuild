// priority: 0
"use strict";
// Подклад: шьётся на швейном столе, к нему пришивается мех - так делаются шубы, ушанки, зимние куртки.
// Сгенерировано gen_wardrobe_recipes.py. Новый предмет: нужен перезапуск и у сервера, и у игроков.
StartupEvents.registry('item', event => {
    event.create('tfg:fur_lining').displayName('Подклад для меха').texture('tfg:item/fur_lining').maxStackSize(16)
    // пинцет: закрепка камней в украшениях (вместе с кусачками) и цепь ожерелья (gen_jewel_recipes.py)
    event.create('tfg:tweezers').displayName('Пинцет').maxDamage(256).tag('tfg:tools/tweezers').unstackable()
})
