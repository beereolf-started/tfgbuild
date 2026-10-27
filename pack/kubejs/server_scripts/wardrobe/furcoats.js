// priority: 0
"use strict";
// Шубы tfgui из шкур зверей tfc_textile: подклад + мех этого зверя + пряжа, игла изнашивается.
// Шуба - 3 шкуры, подол - 2 (как было у шуб Cozy, которые теперь скрыты).
ServerEvents.recipes(event => {
    ;['black_bear', 'grizzly_bear', 'polar_bear', 'direwolf', 'cougar', 'panther', 'lion', 'tiger', 'sabertooth', 'caribou'].forEach(a => {
        event.recipes.tfc.damage_inputs_shapeless_crafting(event.shapeless('tfgui:fur_coat_' + a,
            ['tfg:fur_lining', '3x tfc_textile:' + a + '_fur', 'tfc:wool_yarn', '#tfc:sewing_needles'])).id('tfg:wardrobe/fur/fur_coat_' + a)
        event.recipes.tfc.damage_inputs_shapeless_crafting(event.shapeless('tfgui:fur_coat_legs_' + a,
            ['tfg:fur_lining', '2x tfc_textile:' + a + '_fur', 'tfc:wool_yarn', '#tfc:sewing_needles'])).id('tfg:wardrobe/fur/fur_coat_legs_' + a)
    })
})
