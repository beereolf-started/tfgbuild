// priority: 0
"use strict";
// Кольца и ткань Epic Knights - из TFG: кольца GregTech, шерстяная ткань TFC.
ServerEvents.tags('item', event => {
    event.add('magistuarmory:rings/steel', '#forge:rings/steel')
    event.add('magistuarmory:woolen_fabrics', 'tfc:wool_cloth')
})
