// priority: 0
"use strict";
// Льняная одежда tfc_textile: у мода нет рецептов, шьётся на швейном столе из ткани сборки
// (льняная tfg:linen_cloth и другая светлая ткань). Своя ткань мода - дубль, скрыта (tags.js).
ServerEvents.recipes(event => {
    event.custom({"type": "tfc:sewing", "stitches": [0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "squares": [-1, -1, 1, 1, 1, 1, -1, -1, -1, 1, 1, 1, 1, 1, 1, -1, 1, 1, -1, -1, -1, -1, 1, 1, -1, -1, -1, -1, -1, -1, -1, -1], "result": {"item": "tfc_textile:linen_hat"}}).id('tfg:wardrobe/sewing/tfc_textile/linen_hat')
    event.custom({"type": "tfc:sewing", "stitches": [1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0], "squares": [1, 1, 1, -1, -1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, 1, 1, 1, 1, -1, -1, -1, -1, 1, 1, 1, 1, -1, -1], "result": {"item": "tfc_textile:linen_shirt"}}).id('tfg:wardrobe/sewing/tfc_textile/linen_shirt')
    event.custom({"type": "tfc:sewing", "stitches": [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0], "squares": [-1, 1, 1, 1, 1, 1, 1, -1, -1, 1, 1, -1, -1, 1, 1, -1, -1, 1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, -1, 1, -1], "result": {"item": "tfc_textile:linen_pants"}}).id('tfg:wardrobe/sewing/tfc_textile/linen_pants')
    event.custom({"type": "tfc:sewing", "stitches": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0], "squares": [-1, -1, -1, -1, -1, -1, -1, -1, -1, 1, -1, -1, -1, -1, 1, -1, -1, 1, -1, -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, 1, -1], "result": {"item": "tfc_textile:linen_socks"}}).id('tfg:wardrobe/sewing/tfc_textile/linen_socks')
})
